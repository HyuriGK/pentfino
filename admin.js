const auth = {
    user: JSON.parse(localStorage.getItem('pentfino_user')) || null,

    init() {
        if (this.user) {
            sessionManager.init();
            this.showDashboard();
        }
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
    clients: [],
    allClients: [], // For filtering
    inventory: [],

    async init() {
        document.getElementById('current-date').innerText = new Date().toLocaleDateString('pt-BR');
        await this.loadData();
        await this.loadClients();
        await this.loadInventory();
        this.startInsights();
    },

    async loadData() {
        try {
            const [aptRes, statRes] = await Promise.all([
                fetch(`/api/appointments/${auth.user.id}`),
                fetch(`/api/stats/${auth.user.id}`)
            ]);
            
            const allApts = await aptRes.json();
            this.pending = allApts.filter(a => a.status === 'pending');
            const stats = await statRes.json();
            
            this.renderAppointments();
            this.updateStats(stats);
            
            if (agenda.calendar) {
                agenda.renderEvents(allApts);
            }
        } catch (err) { console.error('Erro ao carregar dados'); }
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
        const tabs = ['home', 'agenda', 'clientes', 'estoque'];
        tabs.forEach(t => {
            const el = document.getElementById(`tab-${t}`);
            if (el) el.classList.toggle('hidden', t !== tab);
        });

        // Toggle "Link Público" button - only show on home tab
        const linkBtn = document.getElementById('public-link-btn');
        if (linkBtn) linkBtn.classList.toggle('hidden', tab !== 'home');

        if (tab === 'agenda') {
            agenda.init();
        }
        
        if (tab === 'clientes') {
            this.loadClients();
        }

        if (tab === 'estoque') {
            this.loadInventory();
        }
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
            await this.loadData();
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
                await this.loadData();
            } catch (err) { alert('Erro ao cancelar serviço'); }
        }
    },

    updateStats(stats) {
        const revenue = parseFloat(stats.revenue || 0);
        document.getElementById('stat-revenue').innerText = `R$ ${revenue.toLocaleString('pt-BR')}`;
        document.getElementById('stat-count').innerText = stats.count || 0;
        document.getElementById('stat-scheduled-count').innerText = this.pending.length;
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
    },

    // CRM / Clients Logic
    async loadClients() {
        try {
            const res = await fetch(`/api/clients/${auth.user.id}`);
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
                    <button class="btn btn-ghost" style="padding: 4px 12px; font-size: 0.7rem;" onclick="window.open('https://wa.me/${c.phone.replace(/\D/g, '')}')">WhatsApp ↗</button>
                </td>
            </tr>
        `).join('');
    },

    async showClientDetails(clientId) {
        try {
            const res = await fetch(`/api/clients/${clientId}/history`);
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
            
            // Render History
            const historyContainer = document.getElementById('client-history-table-body');
            historyContainer.innerHTML = history.length > 0 ? history.map(h => `
                <tr style="background: rgba(255,255,255,0.02)">
                    <td style="padding: 15px;">${new Date(h.created_at).toLocaleDateString('pt-BR')} ${h.appointment_time}</td>
                    <td style="padding: 15px;">${h.service_name}</td>
                    <td style="padding: 15px;">R$ ${parseFloat(h.service_price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                    <td style="padding: 15px;"><span class="status-badge ${h.status === 'completed' ? 'status-ok' : (h.status === 'canceled' ? 'status-danger' : 'status-warn')}">${h.status}</span></td>
                </tr>
            `).join('') : '<tr><td colspan="4" style="text-align:center; padding: 30px; color: var(--text-muted);">Nenhum atendimento realizado ainda.</td></tr>';
            
            this.openModal('client-details');
        } catch (err) {
            console.error('Erro ao buscar detalhes do cliente', err);
            alert('Erro ao carregar histórico do cliente');
        }
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
            const res = await fetch(`/api/inventory/${auth.user.id}`);
            this.inventory = await res.json();
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
                    <td>${i.quantity} ${i.unit}</td>
                    <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                    <td>
                        <div style="display:flex; gap:8px;">
                            <button class="btn btn-ghost" style="padding: 4px 12px; font-size: 1rem;" onclick="admin.updateQty(${i.id}, ${i.quantity - 1})">-</button>
                            <button class="btn btn-ghost" style="padding: 4px 12px; font-size: 1rem;" onclick="admin.updateQty(${i.id}, ${i.quantity + 1})">+</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    },

    async updateQty(id, newQty) {
        if (newQty < 0) return;
        try {
            await fetch(`/api/inventory/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity: newQty })
            });
            this.loadInventory();
        } catch (err) { alert('Erro ao atualizar quantidade'); }
    },

    // Modal Logic
    openModal(type) {
        document.getElementById(`modal-${type}`).classList.remove('hidden');
    },

    closeModal(type) {
        document.getElementById(`modal-${type}`).classList.add('hidden');
    },

    async saveClient() {
        const name = document.getElementById('modal-client-name').value;
        const phone = document.getElementById('modal-client-phone').value;
        const notes = document.getElementById('modal-client-notes').value;

        if(!name || !phone) return alert('Nome e Telefone são obrigatórios');

        try {
            await fetch('/api/clients', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ barberId: auth.user.id, name, phone, notes })
            });
            this.closeModal('client');
            this.loadClients();
        } catch (err) { alert('Erro ao salvar cliente'); }
    },

    async saveInventory() {
        const itemName = document.getElementById('modal-inv-name').value;
        const quantity = parseInt(document.getElementById('modal-inv-qty').value) || 0;
        const unit = document.getElementById('modal-inv-unit').value || 'un';
        const minQuantity = parseInt(document.getElementById('modal-inv-min').value) || 5;

        if(!itemName) return alert('Nome do produto é obrigatório');

        try {
            await fetch('/api/inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ barberId: auth.user.id, itemName, quantity, unit, minQuantity })
            });
            this.closeModal('inventory');
            this.loadInventory();
        } catch (err) { alert('Erro ao salvar item'); }
    }
};

const agenda = {
    calendar: null,

    init() {
        const calendarEl = document.getElementById('calendar');
        if (!calendarEl || this.calendar) return;

        this.calendar = new FullCalendar.Calendar(calendarEl, {
            initialView: 'timeGridDay',
            headerToolbar: {
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,timeGridDay'
            },
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
                
                if (status === 'pending') {
                    if (confirm(`Finalizar serviço para ${info.event.title}?`)) {
                        admin.completeService(id);
                    }
                } else {
                    alert(`Cliente: ${info.event.title}\nServiço: ${info.event.extendedProps.service}\nStatus: ${status}`);
                }
            }
        });

        this.calendar.render();
        admin.loadData(); // This will populate events
    },

    renderEvents(appointments) {
        if (!this.calendar) return;

        const events = appointments.map(a => {
            // Use the date from DB or fallback to today
            let dateStr = a.appointment_date;
            if (dateStr) {
                // Handle different format possibilities (ISO or localized)
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
                extendedProps: {
                    service: a.service_name,
                    status: a.status
                }
            };
        });

        this.calendar.removeAllEvents();
        this.calendar.addEventSource(events);
    }
};

const sessionManager = {
    TIMEOUT_MS: 3600000, // 1 hour
    STORAGE_KEY: 'pentfino_last_activity',

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
            console.warn('Sessão expirada por inatividade (Pentfino).');
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
