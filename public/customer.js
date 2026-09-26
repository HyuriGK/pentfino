const bookingUrlParams = new URLSearchParams(window.location.search);
const bookingPathParts = window.location.pathname.split('/').filter(Boolean);
const bookingPathSlug = bookingPathParts.length === 1 && !bookingPathParts[0].includes('.') ? decodeURIComponent(bookingPathParts[0]) : '';
const bookingQueryId = parseInt(bookingUrlParams.get('businessId') || bookingUrlParams.get('barberId'), 10) || 0;

const app = {
    services: [],
    professionals: [],
    availableTimes: [],
    bookingSettings: null,
    
    // Legacy query links remain supported; new links resolve the business slug first.
    barberId: bookingQueryId,
    businessSlug: bookingPathSlug,

    booking: {
        service: null,
        professional: null,
        time: null,
        client: { name: '', phone: '' }
    },
    bookedAppointments: [],
    availabilityLoaded: false,
    myAppointments: [],
    dateStripStart: null,

    async init() {
        await this.loadInitialData();
        this.applyBookingTheme();
        this.setDefaultDate();
        this.renderServices();
        this.renderTimes();
        this.bindEvents();
        this.simulateRetentionInsight();
    },

    async loadInitialData() {
        try {
            if (!this.barberId && this.businessSlug) {
                const businessResponse = await fetch('/api/public/business/' + encodeURIComponent(this.businessSlug));
                if (businessResponse.ok) {
                    const businessData = await businessResponse.json();
                    this.barberId = Number(businessData.business?.id) || 0;
                }
            }
            if (!this.barberId && !this.businessSlug) this.barberId = 1;

            const [svcRes, profRes, settingsRes] = await Promise.all([
                fetch(`/api/services/${this.barberId}`),
                fetch(`/api/professionals/${this.barberId}`),
                fetch(`/api/public/settings/${this.barberId}`)
            ]);
            this.services = await svcRes.json();
            this.professionals = await profRes.json();
            const settingsData = settingsRes.ok ? await settingsRes.json() : {};
            this.bookingSettings = settingsData.settings || this.getDefaultBookingSettings();
        } catch (err) { console.error('Erro ao carregar dados iniciais'); }
        if (!this.bookingSettings) this.bookingSettings = this.getDefaultBookingSettings();
    },

    getDefaultBookingSettings() {
        return {
            bookingStyle: 'classic',
            intervalMinutes: 60,
            breakEnabled: true,
            breakStart: '12:00',
            breakEnd: '14:00',
            allowCustomTime: true,
            blockedDates: [],
            blockedTimes: [],
            weeklySchedule: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), {
                enabled: true,
                start: '09:00',
                end: '18:00'
            }]))
        };
    },

    applyBookingTheme() {
        const style = ['classic', 'gold', 'minimal', 'red', 'graphite', 'ocean'].includes(this.bookingSettings?.bookingStyle)
            ? this.bookingSettings.bookingStyle
            : 'classic';
        document.body.classList.remove(
            'booking-theme-classic',
            'booking-theme-gold',
            'booking-theme-minimal',
            'booking-theme-red',
            'booking-theme-graphite',
            'booking-theme-ocean'
        );
        document.body.classList.add(`booking-theme-${style}`);
    },

    timeToMinutes(value) {
        const [hours, minutes] = String(value || '').split(':').map(Number);
        return (hours * 60) + minutes;
    },

    durationToMinutes(value) {
        const text = String(value ?? '').trim().toLowerCase().replace(',', '.');
        const match = text.match(/(\d+(?:\.\d+)?)\s*(hora|horas|h|minuto|minutos|min|m)?/i);
        if (!match) return 30;
        const amount = Number(match[1]);
        if (!Number.isFinite(amount) || amount <= 0) return 30;
        return /^h/i.test(match[2] || '') ? Math.round(amount * 60) : Math.round(amount);
    },

    serviceDurationMinutes() {
        return this.durationToMinutes(this.booking.service?.duration || 30);
    },

    getBusinessClock() {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        }).formatToParts(new Date()).map(part => [part.type, part.value]));
        return {
            date: `${parts.year}-${parts.month}-${parts.day}`,
            minutes: (Number(parts.hour) * 60) + Number(parts.minute)
        };
    },

    rangesOverlap(startA, endA, startB, endB) {
        return startA < endB && startB < endA;
    },

    getBookingDayContext(dateValue) {
        const dateKey = String(dateValue || '').slice(0, 10);
        if ((this.bookingSettings?.blockedDates || []).includes(dateKey)) return null;
        const dateParts = dateKey.split('-').map(Number);
        if (dateParts.length !== 3 || dateParts.some(Number.isNaN)) return null;

        const date = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
        if (date.getFullYear() !== dateParts[0] || date.getMonth() !== dateParts[1] - 1 || date.getDate() !== dateParts[2]) return null;
        const schedule = this.bookingSettings?.weeklySchedule?.[String(date.getDay())];
        return schedule?.enabled ? { dateKey, schedule } : null;
    },

    isBookingWindowBlocked(dateValue, timeValue, durationMinutes = this.serviceDurationMinutes()) {
        const context = this.getBookingDayContext(dateValue);
        if (!context) return true;

        const start = this.timeToMinutes(timeValue);
        const end = start + Math.max(1, Number(durationMinutes) || 30);
        const scheduleStart = this.timeToMinutes(context.schedule.start);
        const scheduleEnd = this.timeToMinutes(context.schedule.end);
        if (start < scheduleStart || end > scheduleEnd) return true;

        const breakStart = this.timeToMinutes(this.bookingSettings?.breakStart);
        const breakEnd = this.timeToMinutes(this.bookingSettings?.breakEnd);
        if (this.bookingSettings?.breakEnabled !== false && breakStart < breakEnd && this.rangesOverlap(start, end, breakStart, breakEnd)) return true;

        return (this.bookingSettings?.blockedTimes || []).some(block => (
            block.date === context.dateKey
            && block.start
            && block.end
            && this.rangesOverlap(start, end, this.timeToMinutes(block.start), this.timeToMinutes(block.end))
        ));
    },

    isBookedTime(timeValue, durationMinutes = this.serviceDurationMinutes()) {
        const start = this.timeToMinutes(timeValue);
        const end = start + Math.max(1, Number(durationMinutes) || 30);
        return this.bookedAppointments.some(appointment => {
            const bookedStart = this.timeToMinutes(appointment.time);
            const bookedEnd = bookedStart + this.durationToMinutes(appointment.duration);
            return this.rangesOverlap(start, end, bookedStart, bookedEnd);
        });
    },

    isTimeInPast(dateValue, timeValue) {
        const selectedDate = String(dateValue || '').slice(0, 10);
        const current = this.getBusinessClock();
        const today = current.date;
        if (selectedDate < today) return true;
        if (selectedDate !== today) return false;
        return this.timeToMinutes(timeValue) <= current.minutes;
    },

    getAvailableTimesForDate(dateValue) {
        const context = this.getBookingDayContext(dateValue);
        if (!context) return [];

        const interval = [15, 30, 60].includes(Number(this.bookingSettings?.intervalMinutes))
            ? Number(this.bookingSettings.intervalMinutes)
            : 60;
        const duration = this.serviceDurationMinutes();
        const start = this.timeToMinutes(context.schedule.start);
        const end = this.timeToMinutes(context.schedule.end);
        const times = [];

        for (let minutes = start; minutes + duration <= end; minutes += interval) {
            const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
            if (this.isBookingWindowBlocked(dateValue, time, duration)) continue;
            times.push(time);
        }
        return times;
    },

    dateToValue(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    },

    parseDateValue(value) {
        const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;
        const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        return Number.isNaN(date.getTime()) ? null : date;
    },

    addCalendarDays(date, amount) {
        const next = new Date(date);
        next.setDate(next.getDate() + amount);
        return next;
    },

    getWeekStart(date) {
        const day = date.getDay();
        return this.addCalendarDays(date, day === 0 ? -6 : 1 - day);
    },

    renderDatePicker() {
        const dateInput = document.getElementById('booking-date');
        const options = document.getElementById('booking-date-options');
        const monthLabel = document.getElementById('booking-date-month');
        const previousButton = document.getElementById('booking-date-prev');
        if (!dateInput || !options || !monthLabel) return;

        const selectedDate = this.parseDateValue(dateInput.value) || new Date();
        const minimumDate = this.parseDateValue(dateInput.min) || this.parseDateValue(this.getBusinessClock().date) || new Date();
        const minimumWeek = this.getWeekStart(minimumDate);
        const startDate = this.parseDateValue(this.dateStripStart) || this.getWeekStart(selectedDate);
        const safeStartDate = startDate < minimumWeek ? minimumWeek : startDate;
        this.dateStripStart = this.dateToValue(safeStartDate);

        const monthText = new Intl.DateTimeFormat('pt-BR', {
            month: 'long',
            year: 'numeric'
        }).format(selectedDate);
        monthLabel.textContent = monthText.charAt(0).toUpperCase() + monthText.slice(1);

        if (previousButton) previousButton.disabled = safeStartDate <= minimumWeek;

        const weekdays = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];
        options.innerHTML = Array.from({ length: 7 }, (_, index) => {
            const date = this.addCalendarDays(safeStartDate, index);
            const value = this.dateToValue(date);
            const isPast = date < minimumDate;
            const isSelected = value === dateInput.value;
            const isToday = value === this.dateToValue(minimumDate);
            return `
                <button type="button" class="booking-date-option${isSelected ? ' selected' : ''}${isToday ? ' today' : ''}" data-date="${value}" role="option" aria-selected="${isSelected}"${isPast ? ' disabled' : ''}>
                    <span class="booking-date-weekday">${weekdays[date.getDay()]}</span>
                    <strong>${date.getDate()}</strong>
                </button>
            `;
        }).join('');
    },

    selectBookingDate(dateValue, keepStrip = true) {
        const dateInput = document.getElementById('booking-date');
        if (!dateInput || !this.parseDateValue(dateValue)) return;
        dateInput.value = dateValue;
        if (!keepStrip) this.dateStripStart = this.dateToValue(this.getWeekStart(this.parseDateValue(dateValue)));
        this.booking.time = null;
        document.getElementById('summary-time-val').innerText = '--';
        this.renderDatePicker();
        if (this.booking.professional) {
            this.loadBookedTimes();
        } else {
            this.renderTimes();
        }
    },

    moveDateStrip(direction) {
        const dateInput = document.getElementById('booking-date');
        const currentStart = this.parseDateValue(this.dateStripStart)
            || this.getWeekStart(this.parseDateValue(dateInput?.value) || new Date());
        const minimumDate = this.parseDateValue(dateInput?.min) || new Date();
        const minimumWeek = this.getWeekStart(minimumDate);
        let nextStart = this.addCalendarDays(currentStart, direction * 7);
        if (nextStart < minimumWeek) nextStart = minimumWeek;
        this.dateStripStart = this.dateToValue(nextStart);
        this.selectBookingDate(this.dateToValue(nextStart));
    },

    setDefaultDate() {
        const dateInput = document.getElementById('booking-date');
        if (dateInput) {
            const today = this.parseDateValue(this.getBusinessClock().date) || new Date();
            dateInput.value = this.dateToValue(today);
            dateInput.min = this.dateToValue(today);
            this.dateStripStart = this.dateToValue(this.getWeekStart(today));
            this.renderDatePicker();
        }
    },

    renderServices() {
        const container = document.getElementById('services-list');
        container.innerHTML = this.services.map(s => {
            const photoUrl = this.safeImageUrl(s.photo_url);
            const serviceName = this.escapeHtml(s.name);
            const safePhotoUrl = this.escapeHtml(photoUrl);
            const serviceInitial = this.escapeHtml(String(s.name || 'S').charAt(0).toUpperCase());
            return `
                <div class="service-card glass" onclick="app.selectService(${s.id}, this)">
                    <div class="service-card-content">
                        <span class="service-card-media${photoUrl ? ' has-photo' : ''}">
                            ${photoUrl ? `<img class="service-card-image" src="${safePhotoUrl}" alt="Imagem de ${serviceName}">` : serviceInitial}
                        </span>
                        <div>
                            <strong>${serviceName}</strong>
                            <p style="font-size: 0.75rem; color: var(--text-muted);">${this.escapeHtml(s.duration)}</p>
                        </div>
                    </div>
                    <div class="price">R$ ${this.escapeHtml(s.price)}</div>
                </div>
            `;
        }).join('');
    },

    renderTimes() {
        const container = document.getElementById('times-list');
        const date = document.getElementById('booking-date')?.value;
        const scheduledTimes = this.getAvailableTimesForDate(date);
        this.availableTimes = scheduledTimes.filter(time => !this.isTimeInPast(date, time));
        if (this.booking.time && this.isTimeInPast(date, this.booking.time)) {
            this.booking.time = null;
            document.getElementById('summary-time-val').innerText = '--';
        }
        const customTimeAllowed = this.bookingSettings?.allowCustomTime !== false;
        const customTimeSelected = customTimeAllowed && this.booking.time && !this.availableTimes.includes(this.booking.time);
        const dayIsOpen = scheduledTimes.length > 0;
        const timesMarkup = scheduledTimes.map(t => {
            const isBooked = this.isBookedTime(t);
            const isPast = this.isTimeInPast(date, t);
            const isUnavailable = isBooked || isPast;
            const isSelected = this.booking.time === t && !isPast && !isBooked;
            const unavailableLabel = isPast ? 'Horário já passado' : 'Horário indisponível para este profissional';
            return `
                <div class="time-card glass ${isUnavailable ? 'booked' : ''} ${isSelected ? 'selected' : ''}"
                     ${isUnavailable ? `aria-disabled="true" title="${unavailableLabel}"` : `onclick="app.selectTime('${t}', this)"`}>
                    ${t}
                </div>
            `;
        }).join('');
        const customTimeMarkup = customTimeAllowed && dayIsOpen ? `
            <div class="time-card time-card-other glass ${customTimeSelected ? 'selected' : ''}" onclick="app.selectCustomTime(this)" onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); app.selectCustomTime(this); }" role="button" tabindex="0" aria-label="Escolher outro hor&aacute;rio">
                <span>
                    <strong>Outro hor&aacute;rio</strong>
                    <small>Definir manualmente</small>
                </span>
            </div>` : '';
        container.innerHTML = dayIsOpen
            ? `${timesMarkup}${customTimeMarkup}`
            : '<div class="time-empty-state">A barbearia n&atilde;o atende neste dia. Escolha outra data.</div>';

        const customPicker = document.getElementById('custom-time-picker');
        const customInput = document.getElementById('custom-time');
        if (customPicker) customPicker.classList.toggle('hidden', !customTimeSelected);
        if (customInput && customTimeSelected) customInput.value = this.booking.time;
    },

    bindEvents() {
        document.getElementById('btn-next-step').onclick = () => this.showStep('professionals');
        document.getElementById('btn-next-to-details').onclick = () => this.showStep('details');
        document.getElementById('id-confirm-booking-btn').onclick = () => this.confirmBooking();

        document.getElementById('btn-start-booking').onclick = () => this.startBooking();
        document.getElementById('btn-open-my-appointments').onclick = () => this.openMyAppointments();
        document.getElementById('btn-back-to-entry-from-lookup').onclick = () => this.showEntryOptions();

        const myAppointmentsForm = document.getElementById('my-appointments-form');
        if (myAppointmentsForm) {
            myAppointmentsForm.onsubmit = (event) => {
                event.preventDefault();
                this.lookupMyAppointments();
            };
        }

        const customTimeInput = document.getElementById('custom-time');
        if (customTimeInput) {
            customTimeInput.oninput = () => this.setCustomTime(customTimeInput.value);
        }

        const dateInput = document.getElementById('booking-date');
        if (dateInput) {
            dateInput.onchange = () => {
                this.selectBookingDate(dateInput.value, false);
            };
        }

        document.getElementById('booking-date-prev')?.addEventListener('click', () => this.moveDateStrip(-1));
        document.getElementById('booking-date-next')?.addEventListener('click', () => this.moveDateStrip(1));
        document.getElementById('booking-date-options')?.addEventListener('click', (event) => {
            const option = event.target.closest('[data-date]');
            if (option && !option.disabled) this.selectBookingDate(option.dataset.date);
        });
    },

    selectService(id, el) {
        document.querySelectorAll('.service-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        this.booking.service = this.services.find(s => s.id === id);
        this.booking.professional = null;
        this.bookedAppointments = [];
        this.availabilityLoaded = false;
        document.getElementById('btn-next-step').disabled = false;
        
        // Live summary
        document.getElementById('active-booking-summary').classList.remove('hidden');
        document.getElementById('summary-service-name').innerText = this.booking.service.name;

        this.renderProfessionals();
    },

    getProfessionalsForSelectedService() {
        const serviceId = Number(this.booking.service?.id);
        if (!Number.isInteger(serviceId)) return [];
        return this.professionals.filter(professional => (
            Array.isArray(professional.services)
            && professional.services.some(service => Number(service.id) === serviceId)
        ));
    },

    safeImageUrl(value) {
        const rawValue = String(value || '').trim();
        if (!rawValue) return '';

        // Photos selected in the administrator are cropped in the browser and
        // persisted as base64 data URLs. Keep accepting remote URLs as well,
        // but reject arbitrary data protocols before placing the value in src.
        if (/^data:image\/(?:avif|gif|jpe?g|png|webp);base64,[a-z0-9+/=\s]+$/i.test(rawValue)) {
            return rawValue;
        }

        try {
            const url = new URL(rawValue, window.location.origin);
            return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
        } catch (_) {
            return '';
        }
    },

    renderProfessionals() {
        const container = document.getElementById('professionals-list');
        const professionals = this.getProfessionalsForSelectedService();
        if (!professionals.length) {
            container.innerHTML = '<div class="time-empty-state">Nenhum profissional está vinculado a este serviço.</div>';
            document.getElementById('btn-next-to-details').disabled = true;
            return;
        }

        container.innerHTML = professionals.map(p => {
            const photoUrl = this.safeImageUrl(p.photo_url);
            const professionalName = this.escapeHtml(p.name);
            const initial = this.escapeHtml(String(p.name || 'P').charAt(0).toUpperCase());
            return `
                <div class="service-card glass" onclick="app.selectProfessional(${p.id}, this)">
                    <div style="display:flex; align-items:center; gap:12px;">
                        <div class="prof-avatar-mini">
                            ${photoUrl ? `<img src="${this.escapeHtml(photoUrl)}" alt="Foto de ${professionalName}">` : `<span aria-hidden="true">${initial}</span>`}
                        </div>
                        <strong>${professionalName}</strong>
                    </div>
                </div>
            `;
        }).join('');
    },

    selectProfessional(id, el) {
        document.querySelectorAll('#professionals-list .service-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        this.booking.professional = this.getProfessionalsForSelectedService().find(p => p.id === id);
        if (!this.booking.professional) return;
        this.availabilityLoaded = false;
        document.getElementById('btn-next-to-details').disabled = false;
        document.getElementById('summary-prof-name').innerText = this.booking.professional.name;
        
        // Reset time when professional changes
        this.booking.time = null;
        document.getElementById('summary-time-val').innerText = '--';
        const customTimeInput = document.getElementById('custom-time');
        const customTimePicker = document.getElementById('custom-time-picker');
        if (customTimeInput) customTimeInput.value = '';
        if (customTimePicker) customTimePicker.classList.add('hidden');
        
        // Load booked times for this new professional
        this.loadBookedTimes();
    },

    async loadBookedTimes() {
        const date = document.getElementById('booking-date').value;
        if (!this.booking.professional || !date) return;

        try {
            const params = new URLSearchParams({
                barberId: String(this.barberId),
                professionalId: String(this.booking.professional.id),
                serviceId: String(this.booking.service?.id || ''),
                date
            });
            const res = await fetch(`/api/appointments/booked/list?${params.toString()}`);
            if (!res.ok) throw new Error('Não foi possível consultar a disponibilidade.');
            const data = await res.json();
            this.bookedAppointments = Array.isArray(data) ? data : [];
            this.availabilityLoaded = true;
            this.renderTimes();
        } catch (err) {
            this.bookedAppointments = [];
            this.availabilityLoaded = false;
            const container = document.getElementById('times-list');
            if (container) container.innerHTML = '<div class="time-empty-state">Não foi possível carregar os horários deste profissional. Tente novamente.</div>';
            console.error('Erro ao carregar horários ocupados');
        }
    },

    selectTime(time, el) {
        const date = document.getElementById('booking-date')?.value;
        if (this.isTimeInPast(date, time) || this.isBookingWindowBlocked(date, time) || this.isBookedTime(time)) {
            this.renderTimes();
            return;
        }
        document.querySelectorAll('.time-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        this.booking.time = time;
        document.getElementById('summary-time-val').innerText = time;
        const customTimeInput = document.getElementById('custom-time');
        const customTimePicker = document.getElementById('custom-time-picker');
        if (customTimeInput) customTimeInput.value = '';
        if (customTimePicker) customTimePicker.classList.add('hidden');
    },

    selectCustomTime(el) {
        const date = document.getElementById('booking-date')?.value;
        if (this.bookingSettings?.allowCustomTime === false || !this.getAvailableTimesForDate(date).length) return;
        document.querySelectorAll('.time-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        this.booking.time = null;
        document.getElementById('summary-time-val').innerText = '--';

        const customTimePicker = document.getElementById('custom-time-picker');
        const customTimeInput = document.getElementById('custom-time');
        if (customTimePicker) customTimePicker.classList.remove('hidden');
        if (customTimeInput) {
            customTimeInput.value = '';
            customTimeInput.focus();
        }
    },

    startBooking() {
        document.getElementById('booking-entry')?.classList.add('hidden');
        document.getElementById('my-appointments-panel')?.classList.add('hidden');
        document.getElementById('booking-flow')?.classList.remove('hidden');
        this.showStep('services');
    },

    openMyAppointments() {
        document.getElementById('booking-entry')?.classList.add('hidden');
        document.getElementById('booking-flow')?.classList.add('hidden');
        document.getElementById('my-appointments-panel')?.classList.remove('hidden');
        document.getElementById('my-appointments-feedback').innerText = '';
        document.getElementById('my-appointments-results').innerHTML = '';
        document.getElementById('my-appointments-phone')?.focus();
    },

    showEntryOptions() {
        document.getElementById('booking-entry')?.classList.remove('hidden');
        document.getElementById('my-appointments-panel')?.classList.add('hidden');
        document.getElementById('booking-flow')?.classList.add('hidden');
    },

    async lookupMyAppointments() {
        const input = document.getElementById('my-appointments-phone');
        const feedback = document.getElementById('my-appointments-feedback');
        const results = document.getElementById('my-appointments-results');
        const button = document.getElementById('btn-search-my-appointments');
        const phone = String(input?.value || '').replace(/\D/g, '');

        if (phone.length < 8 || phone.length > 15) {
            feedback.className = 'my-appointments-feedback is-error';
            feedback.innerText = 'Informe um WhatsApp válido para consultar.';
            results.innerHTML = '';
            return;
        }

        button.disabled = true;
        feedback.className = 'my-appointments-feedback is-loading';
        feedback.innerText = 'Consultando seus agendamentos...';
        results.innerHTML = '';

        try {
            const params = new URLSearchParams({ barberId: this.barberId, phone });
            const response = await fetch(`/api/public/appointments?${params.toString()}`);
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.message || 'Não foi possível consultar os agendamentos.');
            }

            this.myAppointments = Array.isArray(data.appointments) ? data.appointments : [];
            this.renderMyAppointments();
            feedback.className = 'my-appointments-feedback';
            feedback.innerText = this.myAppointments.length
                ? 'Agendamentos finalizados encontrados.'
                : 'Nenhum agendamento finalizado encontrado para este WhatsApp.';
        } catch (error) {
            feedback.className = 'my-appointments-feedback is-error';
            feedback.innerText = error.message || 'Não foi possível consultar os agendamentos.';
        } finally {
            button.disabled = false;
        }
    },

    renderMyAppointments() {
        const results = document.getElementById('my-appointments-results');
        if (!results) return;

        results.innerHTML = this.myAppointments.map(appointment => `
            <article class="my-appointment-card">
                <div class="my-appointment-card-top">
                    <span class="my-appointment-status">Finalizado</span>
                    <strong>${this.escapeHtml(appointment.appointment_date_display)} &agrave;s ${this.escapeHtml(appointment.appointment_time_display)}</strong>
                </div>
                <div class="my-appointment-card-details">
                    <div>
                        <span>Servi&ccedil;o</span>
                        <strong>${this.escapeHtml(appointment.service_name)}</strong>
                    </div>
                    <div>
                        <span>Barbeiro</span>
                        <strong>${this.escapeHtml(appointment.professional_name || 'Equipe')}</strong>
                    </div>
                </div>
            </article>
        `).join('');
    },

    escapeHtml(value) {
        const element = document.createElement('span');
        element.textContent = value == null ? '' : String(value);
        return element.innerHTML;
    },

    setCustomTime(time) {
        const date = document.getElementById('booking-date')?.value;
        if (this.bookingSettings?.allowCustomTime === false || !this.getAvailableTimesForDate(date).length) return;
        const isValidTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
        if (!isValidTime || this.isTimeInPast(date, time) || this.isBookingWindowBlocked(date, time) || this.isBookedTime(time)) {
            this.booking.time = null;
            document.getElementById('summary-time-val').innerText = '--';
            return;
        }

        this.booking.time = time;
        document.querySelectorAll('.time-card').forEach(c => c.classList.remove('selected'));
        document.querySelector('.time-card-other')?.classList.add('selected');
        document.getElementById('summary-time-val').innerText = time;
    },

    showStep(stepId) {
        document.body.classList.toggle('booking-success-active', stepId === 'success');
        document.getElementById('booking-entry')?.classList.add('hidden');
        document.getElementById('my-appointments-panel')?.classList.add('hidden');
        document.getElementById('booking-flow')?.classList.remove('hidden');
        ['services', 'professionals', 'details', 'success'].forEach(s => {
            const el = document.getElementById(`step-${s}`);
            if (el) el.classList.add('hidden');
        });
        document.getElementById(`step-${stepId}`).classList.remove('hidden');
    },

    async confirmBooking() {
        const name = document.getElementById('client-name').value;
        const phone = document.getElementById('client-phone').value;
        const date = document.getElementById('booking-date').value;

        const validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(this.booking.time || '');
        if (!this.booking.service || !this.booking.professional) {
            alert('Escolha o serviço e o profissional antes de continuar.');
            return;
        }
        if (!this.availabilityLoaded) {
            alert('A disponibilidade deste profissional ainda não foi carregada. Tente novamente.');
            return;
        }
        if (!validTime || this.isTimeInPast(date, this.booking.time)) {
            alert('Escolha um horário válido.');
            this.renderTimes();
            return;
        }
        if (this.isBookingWindowBlocked(date, this.booking.time) || this.isBookedTime(this.booking.time)) {
            alert('Este horário acabou de ficar indisponível para este profissional. Escolha outro.');
            this.loadBookedTimes();
            this.renderTimes();
            return;
        }
        if (!name || !phone || !date) {
            alert('Por favor, preencha todos os campos e escolha um horário.');
            return;
        }

        try {
            const res = await fetch('/api/appointments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    barberId: this.barberId,
                    serviceId: this.booking.service.id,
                    professionalId: this.booking.professional?.id,
                    clientName: name,
                    clientPhone: phone,
                    time: this.booking.time,
                    date: date
                })
            });

            if (res.ok) {
                document.getElementById('summary-content').innerHTML = `
                    <div class="success-card-heading">
                        <span>Resumo do agendamento</span>
                        <span class="success-card-status">Confirmado</span>
                    </div>
                    <div class="confirmation-service">
                        <span class="confirmation-label">Serviço escolhido</span>
                        <strong>${this.escapeHtml(this.booking.service.name)}</strong>
                    </div>
                    <div class="confirmation-details">
                        <div class="confirmation-row">
                            <span>Data e horário</span>
                            <strong>${this.escapeHtml(new Date(`${date}T00:00:00`).toLocaleDateString('pt-BR'))} às ${this.escapeHtml(this.booking.time)}</strong>
                        </div>
                        <div class="confirmation-row">
                            <span>Barbeiro</span>
                            <strong>${this.escapeHtml(this.booking.professional?.name || 'Não selecionado')}</strong>
                        </div>
                    </div>
                `;
                this.showStep('success');
            } else {
                const data = await res.json();
                alert(data.message || 'Erro ao confirmar agendamento');
                // Refresh booked times in case someone just booked it
                this.loadBookedTimes();
            }
        } catch (err) { alert('Erro de conexão'); }
    },

    simulateRetentionInsight() {
        const tips = [
            "Faltam apenas 3 horários para hoje!",
            "Promoção: pacote de serviços com 10% de desconto para clientes recorrentes.",
            "Mais de 500 agendamentos realizados este mês na barbearia.",
        ];
        
        setInterval(() => {
            const tipEl = document.getElementById('retention-tip');
            if(tipEl) {
                const randomTip = tips[Math.floor(Math.random() * tips.length)];
                tipEl.innerText = randomTip;
            }
        }, 8000);
    }
};

window.onload = () => app.init();
