const auth = {
    user: JSON.parse(localStorage.getItem('pentfino_user')) || null,

    init() {
        if (this.user) this.showDashboard();
    },

    toggleForm(type) {
        document.getElementById('login-form').classList.toggle('hidden', type === 'register');
        document.getElementById('register-form').classList.toggle('hidden', type === 'login');
    },

    async login() {
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (data.success) {
                this.user = data.user;
                localStorage.setItem('pentfino_user', JSON.stringify(this.user));
                this.showDashboard();
            } else {
                alert(data.message);
            }
        } catch (err) { alert('Erro ao conectar ao servidor'); }
    },

    async register() {
        const shop = document.getElementById('reg-shop').value;
        const email = document.getElementById('reg-email').value;
        const password = document.getElementById('reg-password').value;
        
        try {
            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, shop })
            });
            const data = await res.json();
            if (data.success) {
                this.user = data.user;
                localStorage.setItem('pentfino_user', JSON.stringify(this.user));
                this.showDashboard();
            } else {
                alert(data.message);
            }
        } catch (err) { alert('Erro ao registrar'); }
    },

    showDashboard() {
        document.getElementById('auth-view').classList.add('hidden');
        document.getElementById('admin-view').classList.remove('hidden');
        document.getElementById('shop-name-title').innerText = `Bem-vindo, ${this.user.shop_name || this.user.shop}`;
        admin.init();
    },

    logout() {
        localStorage.removeItem('pentfino_user');
        location.reload();
    }
};

const admin = {
    pending: [],
    history: [],

    async init() {
        document.getElementById('current-date').innerText = new Date().toLocaleDateString('pt-BR');
        await this.loadData();
        this.startInsights();
    },

    async loadData() {
        try {
            const [aptRes, statRes] = await Promise.all([
                fetch(`/api/appointments/${auth.user.id}`),
                fetch(`/api/stats/${auth.user.id}`)
            ]);
            
            this.pending = await aptRes.json();
            const stats = await statRes.json();
            
            this.renderAppointments();
            this.updateStats(stats);
        } catch (err) { console.error('Erro ao carregar dados'); }
    },

    showTab(tab) {
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        const target = [...document.querySelectorAll('.nav-item')].find(el => el.innerText.toLowerCase().includes(tab.toLowerCase()));
        if(target) target.classList.add('active');
        
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
                    <h4 style="font-size: 1.25rem; letter-spacing: -0.5px;">${a.client_name}</h4>
                    <p style="text-transform: uppercase; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.1em; color: var(--text-muted);">
                        ${a.service_name} <span style="margin: 0 8px; opacity: 0.3;">•</span> <span style="color: var(--primary);">${a.appointment_time}</span>
                    </p>
                </div>
                <div class="action-btns">
                    <button class="btn btn-primary" style="padding: 10px 20px; font-size: 0.8rem;" onclick="admin.completeService(${a.id})">Finalizar</button>
                    <button class="btn btn-ghost" style="padding: 10px; color: var(--danger); border-color: rgba(255,68,68,0.2);" onclick="admin.cancelService(${a.id})">×</button>
                </div>
            </div>
        `).join('');
    },

    async completeService(id) {
        try {
            await fetch(`/api/appointments/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'completed' })
            });
            this.loadData();
        } catch (err) { alert('Erro ao finalizar serviço'); }
    },

    async cancelService(id) {
        if (confirm('Deseja cancelar este agendamento?')) {
            try {
                await fetch(`/api/appointments/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'canceled' })
                });
                this.loadData();
            } catch (err) { alert('Erro ao cancelar serviço'); }
        }
    },

    updateStats(stats) {
        const revenue = parseFloat(stats.revenue || 0);
        document.getElementById('stat-revenue').innerText = `R$ ${revenue.toLocaleString('pt-BR')}`;
        document.getElementById('stat-count').innerText = stats.count || 0;
    },

    startInsights() {
        const tips = [
            "Aumento de 20% na procura por serviços esta semana.",
            "Insight Pentfino: Ofereça um café aos clientes que chegarem 10min antes.",
            "Lembrete: Foque em retenção este mês para dobrar o lucro.",
            "Atenção: Seu faturamento cresceu 15% em relação ao mês anterior."
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

window.onload = () => auth.init();
