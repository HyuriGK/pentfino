const auth = {
    user: (() => {
        try {
            return JSON.parse(localStorage.getItem('pentfino_user'));
        } catch (e) {
            console.error('Erro ao ler usuário do localStorage', e);
            return null;
        }
    })(),

    init() {
        if (this.user && typeof this.user === 'object' && this.user.id) {
            try {
                sessionManager.init();
                this.showDashboard();
            } catch (err) {
                console.error('Erro durante inicialização do auth:', err);
            }
        }
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
                localStorage.setItem('pentfino_user', JSON.stringify(this.user));
                this.showDashboard();
            } else {
                alert(data.message || 'Erro ao realizar login');
            }
        } catch (err) { 
            console.error('Login Error:', err);
            if (err.name === 'AbortError') {
                alert('O servidor demorou muito para responder. Verifique sua conexão.');
            } else {
                alert('Erro ao conectar ao servidor. Verifique se a API está online.');
            }
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
    professionals: [],
    services: [],

    async init() {
        document.getElementById('current-date').innerText = new Date().toLocaleDateString('pt-BR');
        await this.loadData();
        await this.loadClients();
        await this.loadInventory();
        await this.loadProfessionals();
        await this.loadServices();
        this.startInsights();
    },

    async loadData() {
        try {
            const [aptRes, statRes] = await Promise.all([
                fetch(`/api/appointments/${auth.user.id}`),
                fetch(`/api/stats/${auth.user.id}`)
            ]);
            
            const allApts = await aptRes.json();
            this.allAppointments = allApts; // Store for agenda filtering
            this.pending = allApts.filter(a => a.status === 'pending');
            const stats = await statRes.json();
            
            this.renderAppointments();
            this.updateStats(stats);
            
            if (agenda.calendar) {
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
        const tabs = ['home', 'agenda', 'clientes', 'estoque', 'profissionais', 'servicos'];
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
        }
        
        if (tab === 'clientes') {
            this.loadClients();
        }

        if (tab === 'estoque') {
            this.loadInventory();
        }

        if (tab === 'profissionais') {
            this.loadProfessionals();
        }

        if (tab === 'servicos') {
            this.loadServices();
        }
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
            const res = await fetch(`/api/appointments/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
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
            const res = await fetch(`/api/appointments/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
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
                    <td style="padding: 15px; color: var(--primary); font-weight: 600;">${h.professional_name || 'Geral'}</td>
                    <td style="padding: 15px;">R$ ${parseFloat(h.service_price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                    <td style="padding: 15px;"><span class="status-badge ${h.status === 'completed' ? 'status-ok' : (h.status === 'canceled' ? 'status-danger' : 'status-warn')}">${h.status}</span></td>
                </tr>
            `).join('') : '<tr><td colspan="5" style="text-align:center; padding: 30px; color: var(--text-muted);">Nenhum atendimento realizado ainda.</td></tr>';
            
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

    // Professionals Management
    async loadProfessionals() {
        try {
            const res = await fetch(`/api/professionals/${auth.user.id}`);
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
                        <div class="prof-card-info">
                            <h3>${p.name}</h3>
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
        const selectedServices = Array.from(document.querySelectorAll('#modal-prof-services-list input:checked')).map(cb => cb.value);

        if(!name) return alert('Nome é obrigatório');

        try {
            await fetch(`/api/professionals/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, phone, photoUrl })
            });
            
            await fetch('/api/professional-services', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profId: id, serviceIds: selectedServices })
            });

            this.closeModal('professional');
            await this.loadProfessionals();
        } catch (err) { alert('Erro ao atualizar profissional'); }
    },

    async deleteProfessional(id, name) {
        if (confirm(`Deseja remover ${name} da equipe? Esta ação não pode ser desfeita.`)) {
            try {
                await fetch(`/api/professionals/${id}`, { method: 'DELETE' });
                await this.loadProfessionals();
            } catch (err) { alert('Erro ao remover profissional'); }
        }
    },

    async saveProfessional() {
        const name = document.getElementById('modal-prof-name').value;
        const phone = document.getElementById('modal-prof-phone').value;
        const photoUrl = document.getElementById('modal-prof-photo').value;
        const selectedServices = Array.from(document.querySelectorAll('#modal-prof-services-list input:checked')).map(cb => cb.value);

        if(!name) return alert('Nome é obrigatório');

        try {
            const res = await fetch('/api/professionals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ barberId: auth.user.id, name, phone, photoUrl })
            });
            const prof = await res.json();
            
            // Link services
            await fetch('/api/professional-services', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profId: prof.id, serviceIds: selectedServices })
            });

            this.closeModal('professional');
            this.loadProfessionals();
        } catch (err) { alert('Erro ao salvar profissional'); }
    },

    // Services Management
    async loadServices() {
        try {
            const res = await fetch(`/api/services/${auth.user.id}`);
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
                </td>
            </tr>
        `).join('');
    },

    async saveService() {
        const name = document.getElementById('modal-svc-name').value;
        const price = document.getElementById('modal-svc-price').value;
        const duration = document.getElementById('modal-svc-duration').value;

        if(!name || !price) return alert('Nome e Preço são obrigatórios');

        try {
            await fetch('/api/services', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ barberId: auth.user.id, name, price, duration })
            });
            this.closeModal('service');
            this.loadServices();
        } catch (err) { alert('Erro ao salvar serviço'); }
    },

    // Modal Logic Overrides
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
        }
        document.getElementById(`modal-${type}`).classList.add('hidden');
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
            navLinks: true,
            navLinkDayClick: (date) => {
                this.calendar.changeView('timeGridWeek', date);
            },
            dayCellDidMount: (info) => {
                const dateStr = info.date.toISOString().split('T')[0];
                const count = this.allAppointments.filter(a => {
                    const aDate = new Date(a.appointment_date).toISOString().split('T')[0];
                    return aDate === dateStr && a.status !== 'canceled';
                }).length;

                if (count > 0 && info.view.type === 'dayGridMonth') {
                    const kpi = document.createElement('span');
                    kpi.className = 'fc-day-kpi';
                    kpi.innerText = count;
                    info.el.querySelector('.fc-daygrid-day-top').appendChild(kpi);
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
