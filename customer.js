const app = {
    services: [],
    professionals: [],
    availableTimes: ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00', '18:00'],
    
    // Dynamic Barber ID from URL
    barberId: parseInt(new URLSearchParams(window.location.search).get('barberId')) || 1,

    booking: {
        service: null,
        professional: null,
        time: null,
        client: { name: '', phone: '' }
    },

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
        container.innerHTML = this.services.map(s => `
            <div class="service-card glass" onclick="app.selectService(${s.id}, this)">
                <div>
                    <strong>${s.name}</strong>
                    <p style="font-size: 0.75rem; color: var(--text-muted);">${s.duration}</p>
                </div>
                <div class="price">R$ ${s.price}</div>
            </div>
        `).join('');
    },

    renderTimes() {
        const container = document.getElementById('times-list');
        container.innerHTML = this.availableTimes.map(t => `
            <div class="time-card glass" onclick="app.selectTime('${t}', this)">
                ${t}
            </div>
        `).join('');
    },

    bindEvents() {
        document.getElementById('btn-next-step').onclick = () => this.showStep('professionals');
        document.getElementById('btn-next-to-details').onclick = () => this.showStep('details');
        document.getElementById('id-confirm-booking-btn').onclick = () => this.confirmBooking();
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
        container.innerHTML = this.professionals.map(p => `
            <div class="service-card glass" onclick="app.selectProfessional(${p.id}, this)">
                <div style="display:flex; align-items:center; gap:12px;">
                    <div class="prof-avatar-mini" style="background-image: url('${p.photo_url || 'https://via.placeholder.com/40'}')"></div>
                    <strong>${p.name}</strong>
                </div>
            </div>
        `).join('');
    },

    selectProfessional(id, el) {
        document.querySelectorAll('#professionals-list .service-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        this.booking.professional = this.professionals.find(p => p.id === id);
        document.getElementById('btn-next-to-details').disabled = false;
        document.getElementById('summary-prof-name').innerText = this.booking.professional.name;
    },

    selectTime(time, el) {
        document.querySelectorAll('.time-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        this.booking.time = time;
        document.getElementById('summary-time-val').innerText = time;
    },

    showStep(stepId) {
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

        if (!this.booking.time || !name || !phone || !date) {
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
                    <p style="margin-bottom: 12px;"><strong style="color: var(--primary);">${this.booking.service.name}</strong></p>
                    <p style="font-size: 0.9rem; color: var(--text-muted);">${new Date(date).toLocaleDateString('pt-BR')} às ${this.booking.time}</p>
                    <p style="font-size: 0.9rem; color: var(--text-muted);">Profissional: ${this.booking.professional?.name || 'Não selecionado'}</p>
                    <p style="font-size: 0.9rem; color: var(--text-muted);">Valor: R$ ${this.booking.service.price}</p>
                `;
                this.showStep('success');
            } else {
                alert('Erro ao confirmar agendamento');
            }
        } catch (err) { alert('Erro de conexão'); }
    },

    simulateRetentionInsight() {
        const tips = [
            "Faltam apenas 3 horários para hoje!",
            "Promoção: Corte + Barba com 10% de desconto seg-qua.",
            "Mais de 500 agendamentos realizados este mês.",
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
