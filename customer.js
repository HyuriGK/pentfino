const app = {
    // Data structures
    services: [
        { id: 1, name: 'Corte de Cabelo', price: 50, duration: '40 min' },
        { id: 2, name: 'Barba Completa', price: 30, duration: '20 min' },
        { id: 3, name: 'Combo (Corte + Barba)', price: 70, duration: '60 min' },
        { id: 4, name: 'Pigmentação', price: 40, duration: '30 min' }
    ],
    availableTimes: ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00', '18:00'],
    
    // State
    booking: {
        service: null,
        time: null,
        client: { name: '', phone: '' }
    },
    history: [], // Completed appointments
    pending: [], // Active bookings

    init() {
        this.renderServices();
        this.renderTimes();
        this.bindEvents();
        this.updateStats();
        this.simulateRetentionInsight();
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
        // Booking Next Button
        document.getElementById('btn-next-step').onclick = () => this.showStep('details');

        // Confirm Booking
        document.getElementById('btn-confirm-booking').onclick = () => this.confirmBooking();
    },

    selectService(id, el) {
        document.querySelectorAll('.service-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        this.booking.service = this.services.find(s => s.id === id);
        document.getElementById('btn-next-step').disabled = false;
    },

    selectTime(time, el) {
        document.querySelectorAll('.time-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        this.booking.time = time;
    },

    showStep(stepId) {
        ['services', 'details', 'success'].forEach(s => {
            document.getElementById(`step-${s}`).classList.add('hidden');
        });
        document.getElementById(`step-${stepId}`).classList.remove('hidden');
    },

    confirmBooking() {
        const name = document.getElementById('client-name').value;
        const phone = document.getElementById('client-phone').value;

        if (!this.booking.time || !name || !phone) {
            alert('Por favor, preencha todos os campos e escolha um horário.');
            return;
        }

        this.booking.client = { name, phone };
        
        // Add to pending (for Admin View)
        const appointment = {
            id: Date.now(),
            ...this.booking,
            status: 'pending'
        };
        this.pending.push(appointment);

        // Render Summary
        document.getElementById('summary-content').innerHTML = `
            <p><strong>Serviço:</strong> ${this.booking.service.name}</p>
            <p><strong>Horário:</strong> Hoje às ${this.booking.time}</p>
            <p><strong>Total:</strong> R$ ${this.booking.service.price}</p>
        `;

        this.renderAppointments();
        this.showStep('success');
    },

    showToast(msg) {
        const toast = document.getElementById('toast');
        document.getElementById('toast-msg').innerText = msg;
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 4000);
    },

    simulateRetentionInsight() {
        const tips = [
            "O cliente 'João Silva' não volta há 22 dias. Enviar lembrete?",
            "Sugestão: 15% de desconto em Barba para quem cortar esta manhã.",
            "60% dos seus clientes preferem o horário das 17:00.",
            "O estoque de Pomada Efeito Matte está no fim (2 unid)."
        ];
        
        setInterval(() => {
            const randomTip = tips[Math.floor(Math.random() * tips.length)];
            const tipEl = document.getElementById('retention-tip');
            if(tipEl) {
                tipEl.style.opacity = 0;
                setTimeout(() => {
                    tipEl.innerText = randomTip;
                    tipEl.style.opacity = 1;
                }, 500);
            }
        }, 8000);
    }
};

// Start App
window.onload = () => app.init();
