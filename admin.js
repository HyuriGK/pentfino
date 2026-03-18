console.log('[BARBERPOINT] admin.js v3 loaded');
// Global State for diagnostic purposes
window.__BARBER_DEBUG__ = {
    lastInventoryLoad: null,
    inventoryCount: 0,
    editingId: null
};

const auth = {
    user: (() => {
        try {
            return JSON.parse(localStorage.getItem('barberpoint_user'));
        } catch (e) {
            console.error('Erro ao ler usuário do localStorage', e);
            return null;
        }
    })(),
    token: localStorage.getItem('barberpoint_token'),

    init() {
        this.setupEventListeners();
        if (this.user && typeof this.user === 'object' && this.user.id) {
            try {
                sessionManager.init();
                this.showDashboard();
            } catch (err) {
                console.error('Erro durante inicialização do auth:', err);
            }
        }
    },

    setupEventListeners() {
        // Login on Enter
        const loginInputs = ['email', 'password'];
        loginInputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter') this.login();
                });
            }
        });

        // Register on Enter
        const registerInputs = ['reg-shop', 'reg-email', 'reg-password'];
        registerInputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter') this.register();
                });
            }
        });
    },

    notify(message, type = 'info') {
        const icon = type === 'error' ? '❌' : (type === 'success' ? '✅' : 'ℹ️');
        const bgColor = type === 'error' ? 'var(--danger)' : (type === 'success' ? 'var(--success)' : 'var(--primary)');
        
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 2rem;
            right: 2rem;
            background: ${bgColor};
            color: white;
            padding: 1rem 1.5rem;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.3);
            display: flex;
            align-items: center;
            gap: 12px;
            z-index: 10000;
            animation: slideIn 0.3s ease-out;
            font-weight: 600;
        `;
        toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease-in forwards';
            setTimeout(() => toast.remove(), 300);
        }, 5000);
    },

    toggleForm(type) {
        document.getElementById('login-form').classList.toggle('hidden', type === 'register');
        document.getElementById('register-form').classList.toggle('hidden', type === 'login');
    },

    async login() {
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        
        if (!email || !password) {
            return alert('Por favor, preencha todos os campos.');
        }
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            if (res.status === 401) {
                return alert('E-mail ou senha incorretos.');
            }

            const data = await res.json();
            if (data.success) {
                this.user = data.user;
                this.token = data.token;
                localStorage.setItem('barberpoint_user', JSON.stringify(this.user));
                localStorage.setItem('barberpoint_token', this.token);
                this.showDashboard();
                this.notify('Acesso autorizado!', 'success');
            } else {
                this.notify(data.message || 'E-mail ou senha incorretos.', 'error');
            }
        } catch (err) { 
            console.error('Login Error:', err);
            this.notify('Erro ao conectar ao servidor. Verifique se a API está online.', 'error');
        }
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
                this.token = data.token;
                localStorage.setItem('barberpoint_user', JSON.stringify(this.user));
                localStorage.setItem('barberpoint_token', this.token);
                this.showDashboard();
                this.notify('Bem-vindo ao BarberPoint!', 'success');
            } else {
                this.notify(data.message, 'error');
            }
        } catch (err) { this.notify('Erro ao realizar cadastro', 'error'); }
    },

    showDashboard() {
        document.getElementById('auth-view').classList.add('hidden');
        document.getElementById('admin-view').classList.remove('hidden');
        document.getElementById('shop-name-title').innerText = `Bem-vindo, ${this.user.shop_name || this.user.shop}`;
        admin.init();
    },

    logout() {
        localStorage.removeItem('barberpoint_user');
        localStorage.removeItem('barberpoint_token');
        location.reload();
    },

    async apiRequest(url, options = {}) {
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers,
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        const res = await fetch(url, { ...options, headers });
        
        if (res.status === 401 || res.status === 403) {
            console.warn('Sessão inválida ou expirada. Redirecionando para login.');
            this.logout();
            throw new Error('Unauthorized');
        }

        return res;
    }
};

const admin = {
    pending: [],
    history: [],
    clients: [],
    allClients: [], // For filtering
    inventory: [],
    sales: [],
    professionals: [],
    services: [],
    editingInventoryId: null,

    async init() {
        document.getElementById('current-date').innerText = new Date().toLocaleDateString('pt-BR');
        await this.loadData();
        await this.loadClients();
        await this.loadInventory();
        await this.loadProfessionals();
        await this.loadServices();
        await this.loadSales();
        this.startInsights();
    },

    async loadData() {
        try {
            const [aptRes, statRes] = await Promise.all([
                auth.apiRequest(`/api/appointments/${auth.user.id}`),
                auth.apiRequest(`/api/stats/${auth.user.id}`)
            ]);
            
            const allApts = await aptRes.json();
            this.allAppointments = allApts; // Store for agenda filtering
            this.pending = allApts.filter(a => a.status === 'pending');
            const stats = await statRes.json();
            
            this.renderAppointments();
            this.updateStats(stats);
            
            if (agenda.calendar) {
                agenda.allAppointments = allApts; // Fix: ensure agenda has the data before renderEvents if needed
                agenda.renderEvents(allApts);
            }
        } catch (err) { console.error('Erro ao carregar dados'); }
    },

    openShareModal() {
        const link = `${window.location.origin}/reserva.html?barberId=${auth.user.id}`;
        document.getElementById('share-link-input').value = link;
        this.openModal('share');
    },

    confirmLogout() {
        this.openModal('logout');
    },

    async copyShareLink() {
        const input = document.getElementById('share-link-input');
        try {
            await navigator.clipboard.writeText(input.value);
            const btn = document.querySelector('#modal-share .btn-primary');
            const originalText = btn.innerText;
            btn.innerText = 'Copiado! ✓';
            btn.style.background = 'var(--success)';
            setTimeout(() => {
                btn.innerText = originalText;
                btn.style.background = '';
            }, 2000);
        } catch (err) {
            alert('Não foi possível copiar o link.');
        }
    },

    startPolling() {
        // Refresh data every 30 seconds
        setInterval(() => {
            if (auth.user) {
                this.loadData();
                console.log('🔄 Agenda auto-atualizada');
            }
        }, 30000);
    },

    showTab(tab) {
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        const target = [...document.querySelectorAll('.nav-item')].find(el => el.innerText.toLowerCase().includes(tab.toLowerCase()));
        if(target) target.classList.add('active');
        
        // Tab display logic
        const tabs = ['home', 'agenda', 'clientes', 'vendas', 'estoque', 'profissionais', 'servicos', 'comissoes'];
        tabs.forEach(t => {
            const el = document.getElementById(`tab-${t}`);
            if (el) el.classList.toggle('hidden', t !== tab);
        });

        // Toggle "Link Público" button - only show on home tab
        const linkBtn = document.getElementById('public-link-btn');
        if (linkBtn) {
            linkBtn.classList.toggle('hidden', tab !== 'home');
            linkBtn.onclick = () => window.open(`reserva.html?barberId=${auth.user.id}`, '_blank');
        }

        if (tab === 'agenda') {
            agenda.init();
            setTimeout(() => {
                if (agenda.calendar) {
                    agenda.calendar.updateSize();
                    agenda.calendar.render();
                }
            }, 50);
        }
        
        if (tab === 'clientes') {
            this.loadClients();
        }

        if (tab === 'estoque') {
            this.loadInventory();
        }

        if (tab === 'vendas') {
            this.loadSales();
        }

        if (tab === 'profissionais') {
            this.loadProfessionals();
        }

        if (tab === 'servicos') {
            this.loadServices();
        }

        if (tab === 'comissoes') {
            this.loadCommissions();
        }
    },

    async loadCommissions() {
        // Ensure we have latest data
        await Promise.all([this.loadProfessionals(), admin.loadData()]);
        
        const container = document.getElementById('commissions-table-body');
        if (!container) return;

        // Default to current month if not set
        if (this.selectedCommMonth === undefined) {
            this.selectedCommMonth = new Date().getMonth();
            this.updateMonthSelectorUI();
        }

        let totalRevenue = 0;
        let totalCommissions = 0;
        let totalToProfessionals = 0;

        const currentYear = new Date().getFullYear();

        const commData = this.professionals.map(p => {
            const profApts = (this.allAppointments || []).filter(a => {
                const aDate = new Date(a.appointment_date);
                const isCorrectMonth = aDate.getMonth() === this.selectedCommMonth && aDate.getFullYear() === currentYear;
                return String(a.professional_id) === String(p.id) && a.status === 'completed' && isCorrectMonth;
            });

            const generated = profApts.reduce((sum, a) => sum + parseFloat(a.service_price || 0), 0);
            const shopShare = generated * (parseFloat(p.commission || 0) / 100);
            const toProfessional = generated - shopShare;

            totalRevenue += generated;
            totalCommissions += shopShare;
            totalToProfessionals += toProfessional;

            return {
                id: p.id,
                name: p.name,
                rate: p.commission || 0,
                generated,
                shopShare,
                toProfessional
            };
        });

        // Update KPIs
        document.getElementById('comm-total-revenue').innerText = `R$ ${totalRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        document.getElementById('comm-total-due').innerText = `R$ ${totalCommissions.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        document.getElementById('comm-total-prof').innerText = `R$ ${totalToProfessionals.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

        // Render Table
        if (commData.length === 0) {
            container.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 40px; color: var(--text-muted);">Nenhum profissional cadastrado para calcular comissões.</td></tr>';
            return;
        }

        container.innerHTML = commData.map(c => `
            <tr onclick="admin.showProfCommDetails(${c.id})" style="cursor: pointer;">
                <td><strong style="color:var(--primary); text-decoration: underline;">${c.name}</strong></td>
                <td><span class="svc-tag" style="background: rgba(255,255,255,0.05); border: 1px solid var(--border-bright);">${c.rate}%</span></td>
                <td style="font-weight: 600;">R$ ${c.generated.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                <td style="color: var(--danger); font-weight: 600;">R$ ${c.shopShare.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                <td style="color: var(--success); font-weight: 700;">R$ ${c.toProfessional.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
            </tr>
        `).join('');
    },

    setCommMonth(m) {
        this.selectedCommMonth = m;
        this.updateMonthSelectorUI();
        this.loadCommissions();
    },

    updateMonthSelectorUI() {
        const btns = document.querySelectorAll('.month-btn');
        btns.forEach((btn, idx) => {
            btn.classList.toggle('active', idx === this.selectedCommMonth);
        });
    },

    async showProfCommDetails(profId) {
        const prof = this.professionals.find(p => String(p.id) === String(profId));
        if (!prof) return;

        const currentYear = new Date().getFullYear();
        const monthNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
        
        const profApts = (this.allAppointments || []).filter(a => {
            const aDate = new Date(a.appointment_date);
            const isCorrectMonth = aDate.getMonth() === this.selectedCommMonth && aDate.getFullYear() === currentYear;
            return String(a.professional_id) === String(profId) && a.status === 'completed' && isCorrectMonth;
        });

        const totalGen = profApts.reduce((sum, a) => sum + parseFloat(a.service_price || 0), 0);
        const shopShare = totalGen * (parseFloat(prof.commission || 0) / 100);
        const profShare = totalGen - shopShare;

        // Fill modal
        document.getElementById('prof-details-name').innerText = prof.name;
        document.getElementById('prof-details-month').innerText = `${monthNames[this.selectedCommMonth]} ${currentYear}`;
        document.getElementById('prof-details-total-gen').innerText = `R$ ${totalGen.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        document.getElementById('prof-details-shop-share').innerText = `R$ ${shopShare.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        document.getElementById('prof-details-prof-share').innerText = `R$ ${profShare.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

        const container = document.getElementById('prof-comm-details-table-body');
        container.innerHTML = profApts.length > 0 ? profApts.map(a => {
            const servicePrice = parseFloat(a.service_price || 0);
            const serviceShopShare = servicePrice * (parseFloat(prof.commission || 0) / 100);
            const serviceProfShare = servicePrice - serviceShopShare;

            return `
                <tr>
                    <td>${new Date(a.appointment_date).toLocaleDateString('pt-BR')} ${a.appointment_time}</td>
                    <td>${a.client_name}</td>
                    <td style="color: var(--primary);">${a.service_name}</td>
                    <td style="font-weight: 600;">R$ ${servicePrice.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                    <td style="color: var(--danger); font-weight: 600;">R$ ${serviceShopShare.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                    <td style="color: var(--success); font-weight: 700;">R$ ${serviceProfShare.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                </tr>
            `;
        }).join('') : '<tr><td colspan="6" style="text-align:center; padding: 30px; color: var(--text-muted);">Nenhum faturamento registrado para este mês.</td></tr>';

        this.openModal('prof-comm-details');
    },

    renderAppointments() {
        const container = document.getElementById('appointments-list');
        if (this.pending.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding: 2rem; color: var(--text-muted);">Tudo pronto! Fila vazia.</div>';
            return;
        }

        container.innerHTML = this.pending.map(a => `
            <div class="appointment-item">
                <div class="client-info">
                    <h4>${a.client_name}</h4>
                    <p>${a.service_name} • ${a.appointment_time}</p>
                    <div class="professional-badge" style="margin-top: 8px;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                        ${a.professional_name || 'Geral'}
                    </div>
                </div>
                <div class="action-btns">
                    <button class="btn btn-primary" onclick="admin.completeService(${a.id}, '${a.client_name}')">Finalizar</button>
                    <button class="btn-queue-cancel" onclick="admin.cancelService(${a.id}, '${a.client_name}')">×</button>
                </div>
            </div>
        `).join('');
    },

    confirmCompleteService(id, clientName) {
        document.getElementById('confirm-service-text').innerText = `Confirmar conclusão do serviço para ${clientName}?`;
        const confirmBtn = document.getElementById('btn-do-complete-service');
        confirmBtn.onclick = () => this.completeService(id);
        this.openModal('confirm-service');
    },

    async completeService(id, clientName = null) {
        if (clientName) {
            document.getElementById('confirm-service-text').innerHTML = `Confirmar conclusão do serviço para <strong>${clientName}</strong>?`;
            document.getElementById('btn-do-complete-service').onclick = () => this.executeCompletion(id);
            this.openModal('confirm-service');
            return;
        }
        
        // Basic fallback if no name passed (legacy)
        if (confirm('Finalizar atendimento?')) {
            this.executeCompletion(id);
        }
    },

    async executeCompletion(id) {
        try {
            const res = await auth.apiRequest(`/api/appointments/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'completed' })
            });
            if (res.ok) {
                this.closeModal('confirm-service');
                this.loadData();
            }
        } catch (err) { alert('Erro ao finalizar serviço'); }
    },

    async cancelService(id, clientName = null) {
        if (clientName) {
            document.getElementById('cancel-service-text').innerHTML = `Deseja cancelar o agendamento de <strong>${clientName}</strong>?`;
            document.getElementById('btn-do-cancel-service').onclick = () => this.executeCancellation(id);
            this.openModal('cancel-service');
            return;
        }

        if (confirm('Deseja cancelar este agendamento?')) {
            this.executeCancellation(id);
        }
    },

    async executeCancellation(id) {
        try {
            const res = await auth.apiRequest(`/api/appointments/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'canceled' })
            });
            if (res.ok) {
                this.closeModal('cancel-service');
                this.loadData();
            }
        } catch (err) { alert('Erro ao cancelar serviço'); }
    },

    updateStats(stats) {
        const revenue = parseFloat(stats.revenue || 0);
        document.getElementById('stat-revenue').innerText = `R$ ${revenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        document.getElementById('stat-count').innerText = stats.count || 0;
        document.getElementById('stat-scheduled-count').innerText = this.pending.length;
    },

    startInsights() {
        const tips = [
            "Aumento de 20% na procura por serviços esta semana.",
            "Insight BarberPoint: Ofereça um café aos clientes que chegarem 10min antes.",
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
    },

    // CRM / Clients Logic
    async loadClients() {
        try {
            const res = await auth.apiRequest(`/api/clients/${auth.user.id}`);
            this.allClients = await res.json();
            this.renderClients(this.allClients);
        } catch (err) { console.error('Erro ao carregar clientes'); }
    },

    renderClients(clientsList) {
        const container = document.getElementById('clients-table-body');
        if (!container) return;

        // Sort: Most recent first (descending)
        const sorted = [...clientsList].sort((a, b) => {
            if (!a.last_service_date) return 1;
            if (!b.last_service_date) return -1;
            return new Date(b.last_service_date) - new Date(a.last_service_date);
        });

        const formatDate = (dateStr, scheduledTime) => {
            if (!dateStr) return 'Nenhum';
            const date = new Date(dateStr);
            const today = new Date();
            
            const isToday = date.getDate() === today.getDate() &&
                          date.getMonth() === today.getMonth() &&
                          date.getFullYear() === today.getFullYear();
            
            const displayTime = scheduledTime || date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

            if (isToday) {
                return `Hoje às ${displayTime}`;
            }
            
            return date.toLocaleDateString('pt-BR') + ' ' + displayTime;
        };

        container.innerHTML = sorted.map(c => `
            <tr>
                <td><strong style="color:var(--primary); cursor:pointer; text-decoration: underline;" onclick="admin.showClientDetails(${c.id})">${c.name}</strong></td>
                <td>${c.phone}</td>
                <td><span style="color:var(--primary)">${formatDate(c.last_service_date, c.scheduled_time)}</span></td>
                <td style="text-align:center">${c.total_appointments || 0}</td>
                <td>
                    <div style="display: flex; gap: 8px; justify-content: center;">
                        <button class="btn btn-ghost" style="padding: 4px 12px; font-size: 0.7rem;" onclick="window.open('https://wa.me/${c.phone.replace(/\D/g, '')}')">WhatsApp ↗</button>
                        <button class="btn btn-ghost" style="color: var(--danger); font-size: 1rem; width: 32px; height: 32px; padding: 0;" onclick="admin.deleteClient(${c.id}, '${c.name.replace(/'/g, "\\'")}')">×</button>
                    </div>
                </td>
            </tr>
        `).join('');
    },

    async showClientDetails(clientId) {
        try {
            const res = await auth.apiRequest(`/api/clients/${clientId}/history`);
            const data = await res.json();
            
            const { client, history, stats } = data;
            
            // Fill headers
            document.getElementById('detail-client-name').innerText = client.name;
            document.getElementById('detail-client-phone').innerText = client.phone;
            
            // Fill KPIs
            const totalSpent = parseFloat(stats.total_spent || 0);
            const visitCount = parseInt(stats.service_count || 0);
            const avgTicket = visitCount > 0 ? totalSpent / visitCount : 0;
            
            document.getElementById('detail-total-spent').innerText = `R$ ${totalSpent.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
            document.getElementById('detail-visit-count').innerText = visitCount;
            document.getElementById('detail-avg-ticket').innerText = `R$ ${avgTicket.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
            
            // Calculate Average Interval
            const completedVisits = history
                .filter(h => h.status === 'completed')
                .sort((a, b) => new Date(a.appointment_date) - new Date(b.appointment_date));

            if (completedVisits.length > 1) {
                let totalDays = 0;
                for (let i = 1; i < completedVisits.length; i++) {
                    const d1 = new Date(completedVisits[i-1].appointment_date);
                    const d2 = new Date(completedVisits[i].appointment_date);
                    const diff = Math.abs(d2 - d1);
                    totalDays += diff / (1000 * 60 * 60 * 24);
                }
                const avg = Math.round(totalDays / (completedVisits.length - 1));
                document.getElementById('detail-avg-interval').innerText = `${avg} dias`;
            } else {
                document.getElementById('detail-avg-interval').innerText = '--';
            }
            
            // Render History
            const historyContainer = document.getElementById('client-history-table-body');
            historyContainer.innerHTML = history.length > 0 ? history.map(h => `
                <tr style="background: rgba(255,255,255,0.02)">
                    <td style="padding: 15px;">${new Date(h.created_at).toLocaleDateString('pt-BR')} ${h.appointment_time}</td>
                    <td style="padding: 15px;">${h.service_name}</td>
                    <td style="padding: 15px; color: var(--primary); font-weight: 600;">${h.professional_name || 'Geral'}</td>
                    <td style="padding: 15px;">R$ ${parseFloat(h.service_price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                    <td style="padding: 15px;"><span class="status-badge ${h.status === 'completed' ? 'status-ok' : (h.status === 'canceled' ? 'status-danger' : 'status-warn')}">${h.status}</span></td>
                    <td style="padding: 15px; text-align: center;">
                        <button class="btn btn-ghost" style="color: var(--danger); width: 32px; height: 32px; padding: 0; font-size: 1.2rem;" onclick="admin.deleteAppointment(${h.id}, ${clientId})">×</button>
                    </td>
                </tr>
            `).join('') : '<tr><td colspan="5" style="text-align:center; padding: 30px; color: var(--text-muted);">Nenhum atendimento realizado ainda.</td></tr>';
            
            this.openModal('client-details');
        } catch (err) {
            console.error('Erro ao buscar detalhes do cliente', err);
            alert('Erro ao carregar histórico do cliente');
        }
    },

    async deleteClient(id, name) {
        this.openDeleteConfirm(`Deseja remover o cliente <strong>${name}</strong> e todo o seu histórico? Esta ação é irreversível.`, async () => {
            try {
                await auth.apiRequest(`/api/clients/${id}`, { method: 'DELETE' });
                this.loadClients();
                this.closeModal('client-details');
                this.closeModal('delete-confirm');
            } catch (err) { alert('Erro ao excluir cliente'); }
        });
    },

    async deleteAppointment(id, clientId) {
        this.openDeleteConfirm('Deseja excluir este registro de atendimento permanentemente?', async () => {
            try {
                await auth.apiRequest(`/api/appointments/${id}`, { method: 'DELETE' });
                this.showClientDetails(clientId);
                this.loadData();
                this.closeModal('delete-confirm');
            } catch (err) { alert('Erro ao excluir atendimento'); }
        });
    },

    openDeleteConfirm(text, onConfirm) {
        document.getElementById('delete-confirm-text').innerHTML = text;
        const btn = document.getElementById('btn-do-delete');
        btn.onclick = onConfirm;
        this.openModal('delete-confirm');
    },

    filterClients() {
        const term = document.getElementById('client-search').value.toLowerCase();
        const filtered = this.allClients.filter(c => 
            c.name.toLowerCase().includes(term) || c.phone.includes(term)
        );
        this.renderClients(filtered);
    },

    // Inventory Logic
    async loadInventory() {
        try {
            const res = await auth.apiRequest(`/api/inventory/${auth.user.id}?t=${Date.now()}`);
            const data = await res.json();
            this.inventory = data;
            
            // Redundancy for sales modal
            window.__BARBER_DEBUG__.lastInventoryContent = data;
            window.__BARBER_DEBUG__.inventoryCount = data.length;
            window.__BARBER_DEBUG__.lastInventoryLoad = new Date().toLocaleTimeString();
            
            this.renderInventory();
        } catch (err) { console.error('Erro ao carregar estoque'); }
    },

    renderInventory() {
        const container = document.getElementById('inventory-table-body');
        if (!container) return;
        container.innerHTML = this.inventory.map(i => {
            const statusClass = i.quantity <= i.min_quantity ? 'status-danger' : 'status-ok';
            const statusText = i.quantity <= i.min_quantity ? 'Baixo Estoque' : 'Em estoque';
            
            return `
                <tr>
                    <td><strong style="color:#fff">${i.item_name}</strong></td>
                    <td style="font-weight: 600;">${i.quantity} <small>${i.unit}</small></td>
                    <td>R$ ${parseFloat(i.unit_price || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                    <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                    <td>
                        <div style="display:flex; gap:8px; align-items: center; justify-content: flex-start;">
                            <button class="btn btn-ghost" style="height: 32px; color: var(--primary); font-size: 0.75rem; padding: 0 12px; border: 1px solid rgba(var(--primary-rgb), 0.2); border-radius: 8px; font-weight: 600; text-transform: uppercase;" onclick="admin.openEditInventory(${i.id})">EDITAR</button>
                            <button class="btn btn-ghost" style="color: var(--danger); font-size: 1.2rem; width: 32px; height: 32px; padding: 0; display: flex; align-items: center; justify-content: center; border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px;" onclick="admin.deleteInventory(${i.id}, '${i.item_name.replace(/'/g, "\\'")}')">×</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    },

    openEditInventory(id) {
        const item = admin.inventory.find(i => String(i.id) === String(id));
        if (!item) {
            console.error('[ERRO] Item não encontrado no inventário local:', id);
            return;
        }

        // Store ID in FOUR places to make it impossible to lose
        admin.editingInventoryId = id;
        document.getElementById('modal-inv-edit-id').value = id;
        
        const modal = document.getElementById('modal-inventory');
        modal.setAttribute('data-edit-id', id);
        
        const saveBtn = modal.querySelector('.btn-primary');
        saveBtn.setAttribute('data-edit-id', id);
        saveBtn.innerText = 'Salvar Alterações';
        
        modal.querySelector('.modal-title').innerText = 'Editar Item';
        
        // Show Debug Info
        const debugDiv = document.getElementById('modal-inv-debug');
        const debugId = document.getElementById('modal-inv-debug-id');
        if (debugDiv && debugId) {
            debugDiv.style.display = 'block';
            debugId.innerText = id;
        }

        document.getElementById('modal-inv-name').value = item.item_name;
        document.getElementById('modal-inv-qty').value = item.quantity;
        document.getElementById('modal-inv-unit').value = item.unit;
        document.getElementById('modal-inv-min').value = item.min_quantity;
        document.getElementById('modal-inv-price').value = item.unit_price || 0;

        console.log('[EDIT] Abrindo edição para ID:', id, 'Nome:', item.item_name);
        admin.openModal('inventory');
    },

    async deleteInventory(id, name) {
        this.openDeleteConfirm(`Deseja remover <strong>${name}</strong> do seu estoque?`, async () => {
            try {
                await auth.apiRequest(`/api/inventory/${id}`, { method: 'DELETE' });
                this.loadInventory();
                this.closeModal('delete-confirm');
            } catch (err) { alert('Erro ao excluir item do estoque'); }
        });
    },

    async updateQty(id, newQty) {
        if (newQty < 0) return;
        try {
            await auth.apiRequest(`/api/inventory/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ quantity: newQty })
            });
            this.loadInventory();
        } catch (err) { alert('Erro ao atualizar quantidade'); }
    },

    // Modal Logic
    async openModal(type) {
        if (type === 'inventory' && admin.editingInventoryId === null) {
            // Reset for "New Item"
            const modal = document.getElementById('modal-inventory');
            modal.querySelector('.modal-title').innerText = 'Novo Item';
            modal.querySelector('.btn-primary').innerText = 'Adicionar ao Estoque';
            document.getElementById('modal-inv-name').value = '';
            document.getElementById('modal-inv-qty').value = '';
            document.getElementById('modal-inv-unit').value = 'un';
            document.getElementById('modal-inv-min').value = '5';
            document.getElementById('modal-inv-price').value = '';
            document.getElementById('modal-inv-edit-id').value = '';
            
            const debugDiv = document.getElementById('modal-inv-debug');
            if (debugDiv) debugDiv.style.display = 'none';
        }

        if (type === 'sale') {
            // Show modal FIRST so user sees something immediately
            document.getElementById('modal-sale').classList.remove('hidden');
            document.body.classList.add('modal-open');
            
            const statusEl = document.getElementById('modal-sale-item-status');
            if (statusEl) statusEl.innerText = 'Sincronizando estoque...';
            
            try {
                await admin.loadInventory();
            } catch(err) {
                console.error('[SALE] Erro ao carregar estoque:', err);
            }
            
            try {
                await admin.loadProfessionals();
            } catch(err) {
                console.error('[SALE] Erro ao carregar profissionais:', err);
            }
            
            // Call prepareSaleModal DIRECTLY (no setTimeout)
            try {
                admin.prepareSaleModal();
            } catch(err) {
                console.error('[SALE] Erro ao popular modal de venda:', err);
                if (statusEl) statusEl.innerText = 'Erro: ' + err.message;
            }
            
            return; // Already showed the modal above, skip the code below
        }

        document.getElementById(`modal-${type}`).classList.remove('hidden');
        document.body.classList.add('modal-open');
    },

    closeModal(type) {
        if (type === 'inventory') {
            admin.editingInventoryId = null;
            document.getElementById('modal-inv-edit-id').value = '';
            const modal = document.getElementById('modal-inventory');
            if (modal) {
                modal.removeAttribute('data-edit-id');
                const btn = modal.querySelector('.btn-primary');
                if (btn) btn.removeAttribute('data-edit-id');
            }
        }
        document.getElementById(`modal-${type}`).classList.add('hidden');
        const isOpen = document.querySelector('.modal-overlay:not(.hidden)');
        if (!isOpen) {
            document.body.classList.remove('modal-open');
        }
    },

    async saveInventory(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        
        if (admin.isSaving) return;
        admin.isSaving = true;

        const btn = document.querySelector('#modal-inventory .btn-primary');
        const modal = document.getElementById('modal-inventory');
        if (btn) {
            btn.disabled = true;
            btn.innerText = 'PROCESSANDO...';
        }

        try {
            const name = document.getElementById('modal-inv-name').value;
            const qty = parseInt(document.getElementById('modal-inv-qty').value);
            const unit = document.getElementById('modal-inv-unit').value;
            const min = parseInt(document.getElementById('modal-inv-min').value);
            const price = parseFloat(document.getElementById('modal-inv-price').value || 0);
            
            // Read ID from FOUR sources (belt and suspenders)
            const src1 = admin.editingInventoryId;
            const src2 = document.getElementById('modal-inv-edit-id').value;
            const src3 = btn ? btn.getAttribute('data-edit-id') : null;
            const src4 = modal ? modal.getAttribute('data-edit-id') : null;
            
            const rawId = src1 || src2 || src3 || src4;
            const finalId = rawId ? parseInt(rawId) : null;
            
            console.log('[SAVE] Sources - var:', src1, 'hidden:', src2, 'btn:', src3, 'modal:', src4, '=> finalId:', finalId);

            if (finalId && !isNaN(finalId)) {
                // UPDATE MODE
                console.log('[SAVE] PATCH mode for ID:', finalId);
                const res = await auth.apiRequest(`/api/inventory/${finalId}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ itemName: name, quantity: qty, unit, minQuantity: min, unitPrice: price })
                });
                if (!res.ok) throw new Error('PATCH failed: ' + res.status);
                auth.notify('Estoque atualizado!', 'success');
            } else {
                // CREATE MODE
                console.log('[SAVE] POST mode (new item)');
                const res = await auth.apiRequest('/api/inventory', {
                    method: 'POST',
                    body: JSON.stringify({ barberId: auth.user.id, itemName: name, quantity: qty, unit, minQuantity: min, unitPrice: price })
                });
                if (!res.ok) throw new Error('POST failed: ' + res.status);
                auth.notify('Item adicionado!', 'success');
            }
            
            // Clean up all ID sources
            admin.editingInventoryId = null;
            document.getElementById('modal-inv-edit-id').value = '';
            if (btn) btn.removeAttribute('data-edit-id');
            if (modal) modal.removeAttribute('data-edit-id');
            admin.closeModal('inventory');
            await admin.loadInventory();
        } catch (err) {
            console.error('[CRITICAL] Erro no salvamento:', err);
            alert('Erro ao salvar no banco de dados. Verifique sua conexão.');
        } finally {
            admin.isSaving = false;
            if (btn) btn.disabled = false;
        }
    },

    // Sales Content
    async loadSales() {
        try {
            const res = await auth.apiRequest(`/api/sales/${auth.user.id}`);
            this.sales = await res.json();
            this.renderSales();
        } catch (err) { console.error('Erro ao carregar vendas'); }
    },

    renderSales() {
        const container = document.getElementById('sales-table-body');
        if (!container) return;

        if (this.sales.length === 0) {
            container.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 40px; color: var(--text-muted);">Nenhuma venda registrada até o momento.</td></tr>';
            return;
        }

        container.innerHTML = this.sales.map(s => `
            <tr>
                <td>${new Date(s.created_at).toLocaleDateString('pt-BR')} ${new Date(s.created_at).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })}</td>
                <td><strong style="color:var(--primary)">${s.item_name}</strong></td>
                <td>${s.quantity}</td>
                <td style="font-weight: 600;">R$ ${parseFloat(s.total_price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                <td>${s.professional_name || '<small style="opacity:0.5">Venda Direta</small>'}</td>
                <td>${s.has_commission ? '<span class="svc-tag" style="color:var(--success)">S</span>' : '<span class="svc-tag" style="color:var(--text-muted)">N</span>'}</td>
            </tr>
        `).join('');
    },

    prepareSaleModal() {
        const itemSelect = document.getElementById('modal-sale-item');
        const profSelect = document.getElementById('modal-sale-prof');
        const statusLabel = document.getElementById('modal-sale-item-status');
        const commRateInput = document.getElementById('modal-sale-comm-rate');
        
        if (!itemSelect) return;

        // Use global window access if local fails
        const items = admin.inventory || window.__BARBER_DEBUG__.lastInventoryContent || [];
        console.log('[SALE] Populando modal de venda. Itens:', items.length);

        if (items.length === 0) {
            itemSelect.innerHTML = '<option value="">(Nenhum produto em estoque)</option>';
            if (statusLabel) statusLabel.innerText = 'Aviso: Lista de estoque está vazia no sistema.';
        } else {
            let options = '<option value="">Selecione um produto...</option>';
            items.forEach(i => {
                options += `<option value="${i.id}">${i.item_name} (${i.quantity} ${i.unit})</option>`;
            });
            itemSelect.innerHTML = options;
            if (statusLabel) statusLabel.innerText = `${items.length} itens prontos para venda.`;
        }
        
        // Populate Professionals
        if (profSelect) {
            let profOptions = '<option value="">Nenhum (Venda Direta)</option>';
            (admin.professionals || []).forEach(p => {
                profOptions += `<option value="${p.id}" data-commission="${p.commission}">${p.name}</option>`;
            });
            profSelect.innerHTML = profOptions;
            
            profSelect.onchange = (e) => {
                const selected = e.target.options[e.target.selectedIndex];
                const comm = selected.dataset.commission || 0;
                if (commRateInput) commRateInput.value = comm;
            };
        }

        // Reset fields
        if (document.getElementById('modal-sale-qty')) document.getElementById('modal-sale-qty').value = 1;
        if (document.getElementById('modal-sale-commission')) document.getElementById('modal-sale-commission').checked = true;
        if (document.getElementById('modal-sale-comm-rate-group')) document.getElementById('modal-sale-comm-rate-group').style.display = 'block';
        if (commRateInput) commRateInput.value = 0;
    },

    async saveSale() {
        const itemId = document.getElementById('modal-sale-item').value;
        const profId = document.getElementById('modal-sale-prof').value;
        const qty = parseInt(document.getElementById('modal-sale-qty').value);
        const hasComm = document.getElementById('modal-sale-commission').checked;
        const commRate = parseFloat(document.getElementById('modal-sale-comm-rate').value || 0);

        if (!itemId || isNaN(qty) || qty <= 0) return alert('Selecione um produto e a quantidade');

        const item = this.inventory.find(i => String(i.id) === String(itemId));
        if (item && qty > item.quantity) {
            return auth.notify(`Estoque insuficiente! Você tem apenas ${item.quantity} ${item.unit}.`, 'error');
        }

        try {
            await auth.apiRequest('/api/sales', {
                method: 'POST',
                body: JSON.stringify({
                    barberId: auth.user.id,
                    itemId,
                    professionalId: profId || null,
                    quantity: qty,
                    price: item.unit_price,
                    hasCommission: hasComm,
                    commissionRate: commRate
                })
            });
            auth.notify('Venda registrada com sucesso!', 'success');
            this.closeModal('sale');
            this.loadSales();
            this.loadInventory();
            this.loadData(); // Update dashboard stats
        } catch (err) { alert('Erro ao registrar venda'); }
    },

    // Professionals Management
    async loadProfessionals() {
        try {
            const res = await auth.apiRequest(`/api/professionals/${auth.user.id}`);
            this.professionals = await res.json();
            this.renderProfessionals();
        } catch (err) { console.error('Erro ao carregar profissionais'); }
    },

    renderProfessionals() {
        const container = document.getElementById('professionals-grid');
        if (!container) return;
        
        if (this.professionals.length === 0) {
            container.innerHTML = `
                <div class="glass" style="grid-column: 1/-1; padding: 4rem; text-align: center; border: 2px dashed var(--border);">
                    <p style="color: var(--text-muted); font-size: 1.1rem;">Nenhum profissional cadastrado ainda.</p>
                    <button class="btn btn-primary" onclick="admin.openModal('professional')" style="margin-top: 1.5rem; display: inline-flex;">Começar agora</button>
                </div>
            `;
            return;
        }

        container.innerHTML = this.professionals.map(p => {
            const initials = p.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
            const services = p.services || [];
            
            return `
                <div class="professional-card">
                    <div class="prof-card-header">
                        <div class="prof-card-avatar" ${p.photo_url ? `style="background-image: url('${p.photo_url}'); color: transparent;"` : ''}>
                            ${p.photo_url ? '' : initials}
                        </div>
                        <div class="prof-card-info" style="flex: 1; min-width: 0;">
                            <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                                <h3 style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.name}</h3>
                                ${p.commission > 0 ? `<span class="svc-tag" style="background: rgba(255,255,255,0.1); border: 1px solid var(--border-bright); flex-shrink: 0;">${p.commission}%</span>` : ''}
                            </div>
                            <p>${p.phone || 'Sem contato'}</p>
                        </div>
                    </div>
                    <div class="prof-card-services">
                        ${services.length > 0 
                            ? services.map(s => `<span class="svc-tag">${s.name}</span>`).join('') 
                            : '<span style="font-size: 0.7rem; color: var(--text-muted); font-style: italic;">Nenhum serviço vinculado</span>'
                        }
                    </div>
                    <div class="prof-card-actions">
                        <button class="btn btn-ghost" onclick="admin.editProfessional(${p.id})">Configurar</button>
                        <button class="btn btn-ghost btn-delete" onclick="admin.deleteProfessional(${p.id}, '${p.name}')">Remover</button>
                    </div>
                </div>
            `;
        }).join('');
    },

    async editProfessional(id) {
        const prof = this.professionals.find(p => p.id === id);
        if (!prof) return;

        // Fill modal fields
        document.getElementById('modal-prof-name').value = prof.name;
        document.getElementById('modal-prof-phone').value = prof.phone || '';
        document.getElementById('modal-prof-photo').value = prof.photo_url || '';
        document.getElementById('modal-prof-commission').value = prof.commission || '';
        
        // Open modal (this will also populate the services list via override)
        this.openModal('professional');

        // Check already linked services
        const selectedIds = (prof.services || []).map(s => s.id);
        const checkboxes = document.querySelectorAll('#modal-prof-services-list input');
        checkboxes.forEach(cb => {
            cb.checked = selectedIds.includes(parseInt(cb.value));
        });

        // Update save button to handle update
        const saveBtn = document.querySelector('#modal-professional .btn-primary');
        const originalText = saveBtn.innerText;
        saveBtn.innerText = 'Salvar Alterações';
        saveBtn.onclick = async () => {
            await this.updateProfessional(id);
            saveBtn.innerText = originalText;
        };
    },

    async updateProfessional(id) {
        const name = document.getElementById('modal-prof-name').value;
        const phone = document.getElementById('modal-prof-phone').value;
        const photoUrl = document.getElementById('modal-prof-photo').value;
        const commission = document.getElementById('modal-prof-commission').value;
        const selectedServices = Array.from(document.querySelectorAll('#modal-prof-services-list input:checked')).map(cb => cb.value);

        if(!name) return alert('Nome é obrigatório');

        try {
            await auth.apiRequest(`/api/professionals/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ name, phone, photoUrl, commission: commission || 0 })
            });
            
            await auth.apiRequest('/api/professional-services', {
                method: 'POST',
                body: JSON.stringify({ profId: id, serviceIds: selectedServices })
            });

            this.closeModal('professional');
            await this.loadProfessionals();
        } catch (err) { alert('Erro ao atualizar profissional'); }
    },

    async deleteProfessional(id, name) {
        if (confirm(`Deseja remover ${name} da equipe? Esta ação não pode ser desfeita.`)) {
            try {
                await auth.apiRequest(`/api/professionals/${id}`, { method: 'DELETE' });
                await this.loadProfessionals();
            } catch (err) { alert('Erro ao remover profissional'); }
        }
    },

    async saveProfessional() {
        const name = document.getElementById('modal-prof-name').value;
        const phone = document.getElementById('modal-prof-phone').value;
        const photoUrl = document.getElementById('modal-prof-photo').value;
        const commission = document.getElementById('modal-prof-commission').value;
        const selectedServices = Array.from(document.querySelectorAll('#modal-prof-services-list input:checked')).map(cb => cb.value);

        if(!name) return alert('Nome é obrigatório');

        try {
            const res = await auth.apiRequest('/api/professionals', {
                method: 'POST',
                body: JSON.stringify({ barberId: auth.user.id, name, phone, photoUrl, commission: commission || 0 })
            });
            const prof = await res.json();
            
            // Link services
            await auth.apiRequest('/api/professional-services', {
                method: 'POST',
                body: JSON.stringify({ profId: prof.id, serviceIds: selectedServices })
            });

            this.closeModal('professional');
            this.loadProfessionals();
        } catch (err) { alert('Erro ao salvar profissional'); }
    },

    // Services Management
    async loadServices() {
        try {
            const res = await auth.apiRequest(`/api/services/${auth.user.id}`);
            this.services = await res.json();
            this.renderServices();
        } catch (err) { console.error('Erro ao carregar serviços'); }
    },

    renderServices() {
        const container = document.getElementById('services-table-body');
        if (!container) return;
        container.innerHTML = this.services.map(s => `
            <tr>
                <td><strong>${s.name}</strong></td>
                <td>${s.duration || '-'}</td>
                <td>R$ ${parseFloat(s.price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                <td>
                    <button class="btn btn-ghost" style="padding: 4px 12px; font-size: 0.7rem;" onclick="admin.editService(${s.id})">Editar</button>
                    <button class="btn btn-ghost" style="padding: 4px 12px; font-size: 0.7rem; color: var(--danger);" onclick="admin.deleteService(${s.id}, '${s.name}')">Excluir</button>
                </td>
            </tr>
        `).join('');
    },

    async editService(id) {
        const svc = this.services.find(s => s.id === id);
        if (!svc) return;

        this.editingServiceId = id;
        document.getElementById('modal-svc-name').value = svc.name;
        document.getElementById('modal-svc-price').value = svc.price;
        document.getElementById('modal-svc-duration').value = svc.duration;

        const saveBtn = document.querySelector('#modal-service .btn-primary');
        saveBtn.innerText = 'Salvar Alterações';
        this.openModal('service');
    },

    async deleteService(id, name) {
        if (confirm(`Deseja excluir o serviço "${name}"?`)) {
            try {
                await auth.apiRequest(`/api/services/${id}`, { method: 'DELETE' });
                this.loadServices();
            } catch (err) { alert('Erro ao excluir serviço'); }
        }
    },

    async saveService() {
        const name = document.getElementById('modal-svc-name').value;
        const price = document.getElementById('modal-svc-price').value;
        const duration = document.getElementById('modal-svc-duration').value;

        if(!name || !price) return alert('Nome e Preço são obrigatórios');

        try {
            const method = this.editingServiceId ? 'PATCH' : 'POST';
            const url = this.editingServiceId ? `/api/services/${this.editingServiceId}` : '/api/services';
            
            await auth.apiRequest(url, {
                method,
                body: JSON.stringify({ barberId: auth.user.id, name, price, duration })
            });

            this.closeModal('service');
            this.loadServices();
        } catch (err) { alert('Erro ao salvar serviço'); }
    },

    // Inventory Helpers
    async saveInventory() {
        const itemName = document.getElementById('modal-inv-name').value;
        const quantity = document.getElementById('modal-inv-qty').value;
        const unit = document.getElementById('modal-inv-unit').value;
        const minQuantity = document.getElementById('modal-inv-min').value;
        const unitPrice = document.getElementById('modal-inv-price').value;

        if(!itemName || !quantity) return alert('Nome e Quantidade são obrigatórios');

        try {
            await auth.apiRequest('/api/inventory', {
                method: 'POST',
                body: JSON.stringify({ 
                    barberId: auth.user.id, 
                    itemName, 
                    quantity, 
                    unit, 
                    minQuantity: minQuantity || 0,
                    unitPrice: unitPrice || 0
                })
            });
            this.closeModal('inventory');
            this.loadInventory();
        } catch (err) { alert('Erro ao salvar item no estoque'); }
    },

    openModal(type) {
        if (type === 'professional') {
            const list = document.getElementById('modal-prof-services-list');
            list.innerHTML = this.services.map(s => `
                <label class="checkbox-item">
                    <input type="checkbox" value="${s.id}">
                    <span>${s.name}</span>
                </label>
            `).join('');
        }
        document.getElementById(`modal-${type}`).classList.remove('hidden');
        document.body.classList.add('modal-open');
    },

    closeModal(type) {
        if (type === 'professional') {
            const saveBtn = document.querySelector('#modal-professional .btn-primary');
            saveBtn.innerText = 'Cadastrar Profissional';
            saveBtn.onclick = () => this.saveProfessional();
            
            // Clear fields
            document.getElementById('modal-prof-name').value = '';
            document.getElementById('modal-prof-phone').value = '';
            document.getElementById('modal-prof-photo').value = '';
            document.getElementById('modal-prof-commission').value = '';
        }
        if (type === 'service') {
            this.editingServiceId = null;
            const saveBtn = document.querySelector('#modal-service .btn-primary');
            saveBtn.innerText = 'Adicionar Serviço';
            
            document.getElementById('modal-svc-name').value = '';
            document.getElementById('modal-svc-price').value = '';
            document.getElementById('modal-svc-duration').value = '';
        }
        if (type === 'inventory') {
            document.getElementById('modal-inv-name').value = '';
            document.getElementById('modal-inv-qty').value = '';
            document.getElementById('modal-inv-unit').value = '';
            document.getElementById('modal-inv-min').value = '';
            document.getElementById('modal-inv-price').value = '';
        }
        document.getElementById(`modal-${type}`).classList.add('hidden');
        const isOpen = document.querySelector('.modal-overlay:not(.hidden)');
        if (!isOpen) {
            document.body.classList.remove('modal-open');
        }
    }
};

const agenda = {
    calendar: null,
    allAppointments: [],

    init() {
        const calendarEl = document.getElementById('calendar');
        if (!calendarEl || this.calendar) return;

        this.calendar = new FullCalendar.Calendar(calendarEl, {
            initialView: 'timeGridWeek',
            headerToolbar: {
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek'
            },
            eventDisplay: 'block',
            dayMaxEvents: 0, // This hides individual events in dayGridMonth view
            navLinks: true,
            navLinkDayClick: (date) => {
                this.calendar.changeView('timeGridWeek', date);
            },
            dayCellDidMount: (info) => {
                const dateStr = info.date.toLocaleDateString('en-CA'); // YYYY-MM-DD local
                const count = this.allAppointments.filter(a => {
                    let aDate = a.appointment_date;
                    if (aDate) {
                        aDate = new Date(aDate).toLocaleDateString('en-CA');
                    }
                    return aDate === dateStr && a.status !== 'canceled';
                }).length;

                if (info.view.type === 'dayGridMonth') {
                    // Remove existing KPIs if any
                    const existing = info.el.querySelector('.fc-day-kpi');
                    if (existing) existing.remove();

                    if (count > 0) {
                        const kpi = document.createElement('button');
                        kpi.className = 'fc-day-kpi';
                        kpi.innerText = count === 1 ? '1 Agendamento' : `${count} Agendamentos`;
                        kpi.onclick = (e) => {
                            e.stopPropagation();
                            this.calendar.changeView('timeGridWeek', info.date);
                        };
                        info.el.querySelector('.fc-daygrid-day-top').appendChild(kpi);
                    }
                }
            },
            slotEventOverlap: false,
            eventMaxStack: 3,
            locale: 'pt-br',
            slotMinTime: '06:00:00',
            slotMaxTime: '24:00:00',
            allDaySlot: false,
            slotLabelFormat: {
                hour: '2-digit',
                minute: '2-digit',
                omitZeroMinute: false,
                meridiem: false
            },
            themeSystem: 'standard',
            height: 'auto',
            events: [],
            eventClick: (info) => {
                const id = info.event.id;
                const status = info.event.extendedProps.status;
                const name = info.event.title;
                
                if (status === 'pending') {
                    admin.completeService(id, name);
                } else {
                    this.showAppointmentDetails(info.event);
                }
            }
        });

        this.calendar.render();
        this.populateBarberFilter();
        admin.loadData();
    },

    populateBarberFilter() {
        const select = document.getElementById('agenda-barber-filter');
        if (!select) return;
        
        const professionals = admin.professionals || [];
        select.innerHTML = '<option value="all">Todos os Barbeiros</option>' +
            professionals.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    },

    filterByProfessional(profId) {
        const apts = this.allAppointments || admin.allAppointments || [];
        if (profId === 'all') {
            this.renderEvents(apts);
        } else {
            const filtered = apts.filter(a => String(a.professional_id) === String(profId));
            this.renderEvents(filtered);
        }
    },

    showAppointmentDetails(event) {
        const name = event.title;
        const service = event.extendedProps.service;
        const status = event.extendedProps.status;
        const time = event.start.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        document.getElementById('view-app-name').innerText = name;
        document.getElementById('view-app-service').innerText = service;
        document.getElementById('view-app-time').innerText = time;
        
        const statusEl = document.getElementById('view-app-status');
        statusEl.innerText = status.toUpperCase();
        statusEl.className = status === 'completed' ? 'status-badge status-ok' : 'status-badge status-danger';

        admin.openModal('view-appointment');
    },

    renderEvents(appointments) {
        if (!this.calendar) return;
        this.allAppointments = appointments;

        const events = appointments.map(a => {
            let dateStr = a.appointment_date;
            if (dateStr) {
                dateStr = new Date(dateStr).toISOString().split('T')[0];
            } else {
                const now = new Date();
                dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            }

            return {
                id: a.id,
                title: a.client_name,
                start: `${dateStr}T${a.appointment_time}:00`,
                backgroundColor: a.status === 'completed' ? '#1a1a1a' : (a.status === 'canceled' ? '#330000' : 'var(--primary)'),
                borderColor: a.status === 'completed' ? '#333' : 'var(--primary)',
                textColor: a.status === 'completed' ? '#555' : '#000',
                classNames: [`event-${a.status}`],
                extendedProps: {
                    service: a.service_name,
                    status: a.status
                }
            };
        });

        this.calendar.removeAllEvents();
        this.calendar.addEventSource(events);
        
        // Re-render if in month view to update KPIs
        if (this.calendar.view.type === 'dayGridMonth') {
            this.calendar.render();
        }
    }
};

const sessionManager = {
    TIMEOUT_MS: 3600000, // 1 hour
    STORAGE_KEY: 'barberpoint_last_activity',

    init() {
        if (!auth.user) return;
        
        this.setupListeners();
        
        // Immediate check on load/init
        this.checkSession();
        
        // Start periodic background check
        this.startChecking();
    },

    setupListeners() {
        const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
        events.forEach(evt => {
            document.addEventListener(evt, () => this.updateActivity(), { passive: true });
        });
        
        // Initial update to mark current time as start
        this.updateActivity();
    },

    updateActivity() {
        localStorage.setItem(this.STORAGE_KEY, Date.now());
    },

    checkSession() {
        if (!auth.user) return;
        
        const lastActivity = parseInt(localStorage.getItem(this.STORAGE_KEY) || 0);
        if (lastActivity === 0) {
            this.updateActivity();
            return;
        }

        const now = Date.now();
        if (now - lastActivity > this.TIMEOUT_MS) {
            console.warn('Sessão expirada por inatividade (BarberPoint).');
            auth.logout();
        }
    },

    startChecking() {
        // Check every 30 seconds for higher precision than 1 minute
        setInterval(() => {
            if (auth.user) {
                this.checkSession();
            }
        }, 30000);
    }
};

const ui = {
    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.toggle('collapsed');
        
        // Save state
        localStorage.setItem('sidebar_collapsed', sidebar.classList.contains('collapsed'));
    },

    init() {
        const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
        if (isCollapsed) {
            document.getElementById('sidebar').classList.add('collapsed');
        }
    }
};

window.onload = () => {
    auth.init();
    ui.init();
    admin.startPolling();
};
// Global Modal Interactions
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const openModal = document.querySelector('.modal-overlay:not(.hidden)');
        if (openModal) {
            const type = openModal.id.replace('modal-', '');
            admin.closeModal(type);
        }
    }
});

document.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        const type = e.target.id.replace('modal-', '');
        admin.closeModal(type);
    }
});

// Extra safety: expose admin globally
window.admin = admin;
