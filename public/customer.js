const app = {
    services: [],
    professionals: [],
    availableTimes: ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00', '18:00'],
    
    // Dynamic business ID from URL. barberId is kept in API payloads for backend compatibility.
    barberId: parseInt(new URLSearchParams(window.location.search).get('businessId') || new URLSearchParams(window.location.search).get('barberId')) || 1,

    booking: {
        service: null,
        professional: null,
        time: null,
        client: { name: '', phone: '' }
    },
    bookedTimes: [],
    myAppointments: [],

    async init() {
        await this.loadInitialData();
        this.renderServices();
        this.renderTimes();
        this.bindEvents();
        this.setDefaultDate();
        this.simulateRetentionInsight();
    },

    async loadInitialData() {
        try {
            const [svcRes, profRes] = await Promise.all([
                fetch(`/api/services/${this.barberId}`),
                fetch(`/api/professionals/${this.barberId}`)
            ]);
            this.services = await svcRes.json();
            this.professionals = await profRes.json();
        } catch (err) { console.error('Erro ao carregar dados iniciais'); }
    },

    setDefaultDate() {
        const dateInput = document.getElementById('booking-date');
        if (dateInput) {
            const today = new Date().toISOString().split('T')[0];
            dateInput.value = today;
            dateInput.min = today;
        }
    },

    renderServices() {
        const container = document.getElementById('services-list');
        container.innerHTML = this.services.map(s => {
            const photoUrl = s.photo_url || '';
            return `
                <div class="service-card glass" onclick="app.selectService(${s.id}, this)">
                    <div class="service-card-content">
                        ${photoUrl ? `<img class="service-card-image" src="${photoUrl}" alt="Imagem de ${s.name}">` : ''}
                        <div>
                            <strong>${s.name}</strong>
                            <p style="font-size: 0.75rem; color: var(--text-muted);">${s.duration}</p>
                        </div>
                    </div>
                    <div class="price">R$ ${s.price}</div>
                </div>
            `;
        }).join('');
    },

    renderTimes() {
        const container = document.getElementById('times-list');
        const customTimeSelected = this.booking.time && !this.availableTimes.includes(this.booking.time);
        container.innerHTML = `${this.availableTimes.map(t => {
            const isBooked = this.bookedTimes.includes(t);
            const isSelected = this.booking.time === t;
            return `
                <div class="time-card glass ${isBooked ? 'booked' : ''} ${isSelected ? 'selected' : ''}"
                     ${isBooked ? '' : `onclick="app.selectTime('${t}', this)"`}>
                    ${t}
                </div>
            `;
        }).join('')}
            <div class="time-card time-card-other glass ${customTimeSelected ? 'selected' : ''}" onclick="app.selectCustomTime(this)">
                Outro
            </div>`;

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
                if (this.booking.professional) {
                    this.loadBookedTimes();
                }
            };
        }
    },

    selectService(id, el) {
        document.querySelectorAll('.service-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        this.booking.service = this.services.find(s => s.id === id);
        document.getElementById('btn-next-step').disabled = false;
        
        // Live summary
        document.getElementById('active-booking-summary').classList.remove('hidden');
        document.getElementById('summary-service-name').innerText = this.booking.service.name;

        // Populate professionals for this service (filtering can be added later)
        this.renderProfessionals();
    },

    renderProfessionals() {
        const container = document.getElementById('professionals-list');
        container.innerHTML = this.professionals.map(p => {
            const photoUrl = p.photo_url || 'https://via.placeholder.com/40';
            return `
                <div class="service-card glass" onclick="app.selectProfessional(${p.id}, this)">
                    <div style="display:flex; align-items:center; gap:12px;">
                        <div class="prof-avatar-mini">
                            <img src="${photoUrl}" alt="Foto de ${p.name}">
                        </div>
                        <strong>${p.name}</strong>
                    </div>
                </div>
            `;
        }).join('');
    },

    selectProfessional(id, el) {
        document.querySelectorAll('#professionals-list .service-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        this.booking.professional = this.professionals.find(p => p.id === id);
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
            const res = await fetch(`/api/appointments/booked/list?barberId=${this.barberId}&professionalId=${this.booking.professional.id}&date=${date}`);
            this.bookedTimes = await res.json();
            this.renderTimes();
        } catch (err) {
            console.error('Erro ao carregar horários ocupados');
        }
    },

    selectTime(time, el) {
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
            feedback.innerText = 'Informe um WhatsApp vÃ¡lido para consultar.';
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
                throw new Error(data.message || 'NÃ£o foi possÃ­vel consultar os agendamentos.');
            }

            this.myAppointments = Array.isArray(data.appointments) ? data.appointments : [];
            this.renderMyAppointments();
            feedback.className = 'my-appointments-feedback';
            feedback.innerText = this.myAppointments.length
                ? 'Agendamentos finalizados encontrados.'
                : 'Nenhum agendamento finalizado encontrado para este WhatsApp.';
        } catch (error) {
            feedback.className = 'my-appointments-feedback is-error';
            feedback.innerText = error.message || 'NÃ£o foi possÃ­vel consultar os agendamentos.';
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
        const isValidTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
        if (!isValidTime) {
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
        if (!validTime || !name || !phone || !date) {
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
                        <strong>${this.booking.service.name}</strong>
                    </div>
                    <div class="confirmation-details">
                        <div class="confirmation-row">
                            <span>Data e horário</span>
                            <strong>${new Date(date).toLocaleDateString('pt-BR')} às ${this.booking.time}</strong>
                        </div>
                        <div class="confirmation-row">
                            <span>Barbeiro</span>
                            <strong>${this.booking.professional?.name || 'Não selecionado'}</strong>
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
