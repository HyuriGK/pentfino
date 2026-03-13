const auth = {
    user: null,

    toggleForm(type) {
        document.getElementById('login-form').classList.toggle('hidden', type === 'register');
        document.getElementById('register-form').classList.toggle('hidden', type === 'login');
    },

    login() {
        const email = document.getElementById('email').value;
        if (!email) return alert('Insira seu email');
        
        this.user = { email, shop: 'Kaza do Barbeiro' };
        this.showDashboard();
    },

    register() {
        const shop = document.getElementById('reg-shop').value;
        const email = document.getElementById('reg-email').value;
        if (!shop || !email) return alert('Preencha os campos');
        
        this.user = { email, shop };
        this.showDashboard();
    },

    showDashboard() {
        document.getElementById('auth-view').classList.add('hidden');
        document.getElementById('admin-view').classList.remove('hidden');
        document.getElementById('shop-name-title').innerText = `Bem-vindo, ${this.user.shop}`;
        admin.init();
    },

    logout() {
        location.reload();
    }
};

const admin = {
    pending: [
        { id: 1, client: { name: 'Gustavo Lima' }, service: { name: 'Corte + Barba', price: 70 }, time: '14:30' },
        { id: 2, client: { name: 'Felipe Rossi' }, service: { name: 'Corte Social', price: 40 }, time: '15:15' }
    ],
    history: [],

    init() {
        document.getElementById('current-date').innerText = new Date().toLocaleDateString('pt-BR');
        this.renderAppointments();
        this.updateStats();
        this.startInsights();
    },

    showTab(tab) {
        // Simplified for MVP - only visual feedback
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        event.currentTarget.classList.add('active');
        
        if (tab !== 'home') alert(`Módulo de ${tab} será liberado na versão 2.0!`);
    },

    renderAppointments() {
        const container = document.getElementById('appointments-list');
        if (this.pending.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding: 2rem; color: var(--text-muted);">Tudo pronto! Fila vazia.</div>';
            return;
        }

        container.innerHTML = this.pending.map(a => `
            <div class="appointment-item glass" style="background: #050505; border: 1px solid var(--border);">
                <div class="client-info">
                    <h4 style="font-size: 1.25rem; letter-spacing: -0.5px;">${a.client.name}</h4>
                    <p style="text-transform: uppercase; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.1em; color: var(--text-muted);">
                        ${a.service.name} <span style="margin: 0 8px; opacity: 0.3;">•</span> <span style="color: var(--primary);">${a.time}</span>
                    </p>
                </div>
                <div class="action-btns">
                    <button class="btn btn-primary" style="padding: 10px 20px; font-size: 0.8rem;" onclick="admin.completeService(${a.id})">Finalizar</button>
                    <button class="btn btn-ghost" style="padding: 10px; color: var(--danger); border-color: rgba(255,68,68,0.2);" onclick="admin.cancelService(${a.id})">×</button>
                </div>
            </div>
        `).join('');
    },

    completeService(id) {
        const index = this.pending.findIndex(a => a.id === id);
        if (index > -1) {
            const completed = this.pending.splice(index, 1)[0];
            this.history.push(completed);
            this.updateStats();
            this.renderAppointments();
        }
    },

    cancelService(id) {
        if (confirm('Deseja cancelar este agendamento?')) {
            this.pending = this.pending.filter(a => a.id !== id);
            this.renderAppointments();
        }
    },

    updateStats() {
        const revenue = this.history.reduce((acc, curr) => acc + curr.service.price, 0);
        document.getElementById('stat-revenue').innerText = `R$ ${revenue.toLocaleString('pt-BR')}`;
        document.getElementById('stat-count').innerText = this.history.length;
    },

    startInsights() {
        const tips = [
            "Aumento de 20% na procura por serviços esta semana.",
            "Insight Pentfino: Ofereça um café aos clientes que chegarem 10min antes.",
            "Lembrete: O cliente 'Felipe Rossi' é recorrente. Ofereça o plano VIP.",
            "Atenção: Seu estoque de lâminas precisa ser renovado em 3 dias."
        ];
        
        let i = 0;
        setInterval(() => {
            const el = document.getElementById('retention-tip');
            if (el) {
                el.innerText = tips[i % tips.length];
                i++;
            }
        }, 10000);
    }
};
