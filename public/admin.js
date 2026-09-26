console.log('[Gestano] admin.js loaded');
// Global State for diagnostic purposes
window.__BARBER_DEBUG__ = {
    lastInventoryLoad: null,
    inventoryCount: 0,
    editingId: null
};

const authStorage = {
    read(key) {
        const storages = [window.localStorage, window.sessionStorage];
        for (const storage of storages) {
            try {
                const value = storage.getItem(key);
                if (value) return value;
            } catch (_) { /* Storage can be unavailable in private/restricted contexts. */ }
        }

        const cookie = document.cookie
            .split('; ')
            .find(item => item.startsWith(`${key}=`));
        return cookie ? decodeURIComponent(cookie.slice(key.length + 1)) : null;
    },

    write(key, value) {
        [window.localStorage, window.sessionStorage].forEach(storage => {
            try { storage.setItem(key, value); } catch (_) { /* Keep the other stores available. */ }
        });
        document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=604800; SameSite=Lax`;
    },

    remove(key) {
        [window.localStorage, window.sessionStorage].forEach(storage => {
            try { storage.removeItem(key); } catch (_) { /* Ignore unavailable storage. */ }
        });
        document.cookie = `${key}=; path=/; max-age=0; SameSite=Lax`;
    }
};

const auth = {
    user: (() => {
        try {
            const stored = authStorage.read('barberpoint_user') || authStorage.read('pontobarber_user');
            if (!stored) return null;
            return JSON.parse(stored);
        } catch (e) {
            console.error('Erro ao ler usuário do localStorage', e);
            return null;
        }
    })(),
    token: authStorage.read('barberpoint_token') || authStorage.read('pontobarber_token'),

    async init() {
        this.setupEventListeners();
        if (!this.user || typeof this.user !== 'object' || !this.user.id || !this.token) {
            document.documentElement.classList.remove('session-restore-pending');
            return;
        }

        if (this.user && typeof this.user === 'object' && this.user.id && this.token) {
            // Restore the authenticated UI immediately on refresh. The token is
            // validated below without flashing the login screen first.
            sessionManager.init();
            this.showDashboard();

            try {
                const sessionRes = await fetch('/api/session', {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });

                if (sessionRes.ok) {
                    const sessionData = await sessionRes.json();
                    this.user = sessionData.user;
                    authStorage.write('barberpoint_user', JSON.stringify(this.user));
                    this.applyDashboardAccess();
                } else if (sessionRes.status === 401 || sessionRes.status === 403) {
                    this.logout();
                    return;
                }
            } catch (err) {
                // Keep the saved session during temporary network/API failures.
                console.warn('Não foi possível validar a sessão agora; mantendo a sessão local.', err);
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

    },

    notify(message, type = 'info') {
        const variant = ['success', 'error', 'info'].includes(type) ? type : 'info';
        const icon = variant === 'error' ? '×' : (variant === 'success' ? '✓' : 'i');
        const title = variant === 'error' ? 'Não foi possível concluir' : (variant === 'success' ? 'Concluído' : 'Atenção');
        const container = document.getElementById('toast-container') || (() => {
            const element = document.createElement('div');
            element.id = 'toast-container';
            element.className = 'app-toast-container';
            element.setAttribute('aria-live', 'polite');
            document.body.appendChild(element);
            return element;
        })();

        const toast = document.createElement('div');
        toast.className = `app-toast app-toast--${variant}`;
        toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
        toast.innerHTML = `
            <span class="app-toast-icon" aria-hidden="true">${icon}</span>
            <span class="app-toast-content">
                <strong class="app-toast-title">${title}</strong>
                <span class="app-toast-message">${message}</span>
            </span>
            <span class="app-toast-progress" aria-hidden="true"></span>
        `;
        container.appendChild(toast);

        const closeToast = () => {
            if (!toast.isConnected) return;
            toast.classList.add('is-closing');
            setTimeout(() => {
                toast.remove();
                if (!container.children.length) container.remove();
            }, 260);
        };

        // The progress bar and dismissal share the same fixed three-second lifetime.
        setTimeout(closeToast, 3000);
    },

    toggleForm(type) {
        document.getElementById('login-form')?.classList.toggle('hidden', type !== 'login');
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
                authStorage.write('barberpoint_user', JSON.stringify(this.user));
                authStorage.write('barberpoint_token', this.token);
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
        this.notify('Novas licenças são liberadas após a demonstração gratuita.', 'info');
    },

    showDashboard() {
        document.documentElement.classList.remove('session-restore-pending');
        document.getElementById('auth-view').classList.add('hidden');
        document.getElementById('admin-view').classList.remove('hidden');
        this.applyDashboardAccess({ animateWelcome: true });
        if (typeof ui !== 'undefined') ui.initNavGroups();
        admin.init();
    },

    getWelcomeMessage() {
        const shopName = this.user?.shop_name || this.user?.shop || 'Gestano';
        const hour = new Date().getHours();
        const greeting = hour < 12 ? 'Bom dia' : (hour < 18 ? 'Boa tarde' : 'Boa noite');
        return `${greeting}, ${shopName}`;
    },

    animateWelcomeMessage() {
        const title = document.getElementById('shop-name-title');
        if (!title) return;

        const message = this.getWelcomeMessage();

        if (this.welcomeTypingTimer) window.clearInterval(this.welcomeTypingTimer);
        if (this.welcomeTypingEndTimer) window.clearTimeout(this.welcomeTypingEndTimer);

        title.setAttribute('aria-label', message);
        title.classList.add('is-typing');
        title.textContent = '';

        let index = 0;
        const typeNextCharacter = () => {
            index += 1;
            title.textContent = message.slice(0, index);

            if (index >= message.length) {
                window.clearInterval(this.welcomeTypingTimer);
                this.welcomeTypingTimer = null;
                this.welcomeTypingEndTimer = window.setTimeout(() => {
                    title.classList.remove('is-typing');
                }, 1400);
            }
        };

        this.welcomeTypingTimer = window.setInterval(typeNextCharacter, 46);
        typeNextCharacter();
    },

    applyDashboardAccess({ animateWelcome = false } = {}) {
        const title = document.getElementById('shop-name-title');
        const message = this.getWelcomeMessage();
        if (title) {
            if (animateWelcome) {
                this.animateWelcomeMessage();
            } else if (!title.classList.contains('is-typing')) {
                title.classList.remove('is-typing');
                title.textContent = message;
                title.setAttribute('aria-label', title.textContent);
            }
        }
        document.querySelectorAll('.admin-only').forEach(el => {
            el.classList.toggle('hidden', this.user.role !== 'administrador');
        });
        document.querySelectorAll('[data-permission]').forEach(el => {
            el.classList.toggle('hidden', !this.can(el.dataset.permission));
        });
        document.querySelectorAll('.nav-group-title[data-group]').forEach(title => {
            const group = title.dataset.group;
            const hasVisibleItem = [...document.querySelectorAll(`[data-sidebar-group="${group}"]`)]
                .some(item => !item.classList.contains('hidden'));
            title.classList.toggle('hidden', !hasVisibleItem);
        });
    },

    can(permission) {
        if (this.user?.role === 'administrador') return true;
        const requiredPermissions = String(permission || '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean);
        return requiredPermissions.length > 0 && requiredPermissions.some(key => this.user?.permissions?.[key] === true);
    },

    logout() {
        document.documentElement.classList.remove('session-restore-pending');
        authStorage.remove('barberpoint_user');
        authStorage.remove('barberpoint_token');
        authStorage.remove('pontobarber_user');
        authStorage.remove('pontobarber_token');
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
        
        if (res.status === 401) {
            console.warn('Sessão inválida ou expirada. Redirecionando para login.');
            this.logout();
            throw new Error('Unauthorized');
        }

        if (res.status === 403) {
            const data = await res.clone().json().catch(() => ({}));
            this.notify(data.message || 'Você não possui permissão para esta ação.', 'error');
            throw new Error('Forbidden');
        }

        return res;
    }
};

const admin = {
    pending: [],
    history: [],
    inventory: [],
    sales: [],
    expenses: [],
    clients: [],
    allClients: [], // For filtering
    users: [],
    marketingLeads: [],
    loyaltyClients: [],
    reportData: null,
    dashboardStats: null,

    professionals: [],
    services: [],
    editingInventoryId: null,
    selectedBillingMonth: new Date().getMonth(),
    selectedBillingYear: new Date().getFullYear(),
    selectedBillingType: 'all',
    selectedExpensePeriod: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
    selectedExpenseMonth: new Date().getMonth(),
    selectedExpenseYear: new Date().getFullYear(),
    monthlyGoal: 0,
    monthlyGoalDefined: false,
    activeAdminPanel: 'overview',
    financialValuesVisible: true,
    currentTab: 'home',
    navigationTimer: null,
    navigationRequestId: 0,
    queueSearchTerm: '',
    bookingSettings: null,
    appointmentPollingTimer: null,
    appointmentsInitialized: false,
    knownPendingAppointmentIds: new Set(),
    confirmedAppointmentIds: new Set(),
    appointmentAlertAudioContext: null,
    professionalPhotoCrop: {
        image: null,
        sourceUrl: '',
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
        dragging: false,
        startX: 0,
        startY: 0,
        startOffsetX: 0,
        startOffsetY: 0
    },
    servicePhotoCrop: {
        image: null,
        sourceUrl: '',
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
        dragging: false,
        startX: 0,
        startY: 0,
        startOffsetX: 0,
        startOffsetY: 0
    },
    inventoryPhotoCrop: {
        image: null,
        sourceUrl: '',
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
        dragging: false,
        startX: 0,
        startY: 0,
        startOffsetX: 0,
        startOffsetY: 0
    },

    async init() {
        this.setupProfessionalPhotoPicker();
        this.setupServicePhotoPicker();
        this.setupInventoryPhotoPicker();
        this.loadFinancialVisibility();
        const dateParts = new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            weekday: 'long',
            day: '2-digit',
            month: 'long',
            year: 'numeric'
        }).formatToParts(new Date()).reduce((result, part) => {
            result[part.type] = part.value;
            return result;
        }, {});
        const weekday = (dateParts.weekday || '').replace(/-feira$/, '');
        const capitalizedWeekday = weekday ? weekday.charAt(0).toUpperCase() + weekday.slice(1) : '';
        const currentDate = document.getElementById('current-date');
        if (currentDate) {
            currentDate.innerHTML = `<span class="dashboard-date-weekday">${capitalizedWeekday},</span> ${dateParts.day} de ${dateParts.month} de ${dateParts.year}`;
        }
        const initialLoads = [];
        if (['dashboard', 'agenda', 'billing', 'comissoes'].some(permission => auth.can(permission))) initialLoads.push(this.loadData());
        if (auth.can('clientes')) initialLoads.push(this.loadClients());
        if (auth.can('estoque') || auth.can('vendas')) initialLoads.push(this.loadInventory());
        if (auth.can('barbeiros') || auth.can('agenda') || auth.can('comissoes')) initialLoads.push(this.loadProfessionals());
        if (auth.can('servicos') || auth.can('agenda')) initialLoads.push(this.loadServices());
        if (auth.can('vendas') || auth.can('comissoes') || auth.can('billing')) initialLoads.push(this.loadSales());
        if (auth.can('despesas')) initialLoads.push(this.loadExpenses());
        await Promise.all(initialLoads);

        if (!auth.can('dashboard')) {
            const firstAvailable = [
            ['agenda', 'agenda'], ['billing', 'billing'], ['clientes', 'clientes'],
            ['vendas', 'vendas'], ['estoque', 'estoque'], ['barbeiros', 'barbeiros'],
            ['comissoes', 'comissoes'], ['servicos', 'servicos'], ['despesas', 'despesas'], ['relatorios', 'relatorios'], ['configuracoes', 'configuracoes']
            ].find(([permission]) => auth.can(permission));
            if (firstAvailable) this.showTab(firstAvailable[1], { skipLoading: true });
        }

        this.setupAppointmentAlertSound();
        this.startAppointmentPolling();

    },

    financialVisibilityStorageKey() {
        const userKey = auth.user?.id || auth.user?.email || 'guest';
        return `barberpoint_financial_visibility_${String(userKey).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    },

    loadFinancialVisibility() {
        const storedValue = authStorage.read(this.financialVisibilityStorageKey());
        this.financialValuesVisible = storedValue !== 'hidden';
        this.applyFinancialVisibility();
    },

    toggleFinancialVisibility() {
        this.financialValuesVisible = !this.financialValuesVisible;
        authStorage.write(this.financialVisibilityStorageKey(), this.financialValuesVisible ? 'visible' : 'hidden');
        this.applyFinancialVisibility();
    },

    maskFinancialValue(value) {
        const text = String(value ?? '');
        return /R\$\s*[-\d.,]+/.test(text)
            ? text.replace(/R\$\s*[-\d.,]+/, 'R$ -----')
            : '-----';
    },

    renderFinancialValue(value, isVisible = true) {
        const text = String(value ?? '');
        const match = text.match(/^(.*?)(R\$)\s*([-\d.,]+)(.*)$/);
        if (!match) return this.escapeHtml(isVisible ? text : this.maskFinancialValue(text));

        const amount = isVisible ? match[3] : '-----';
        return `${this.escapeHtml(match[1])}<span class="financial-money"><span class="financial-currency">R$</span><span class="financial-amount">${amount}</span></span>${this.escapeHtml(match[4])}`;
    },

    applyFinancialVisibility() {
        const isVisible = this.financialValuesVisible;
        document.querySelectorAll('[data-financial-value]').forEach(element => {
            const visibleValue = element.dataset.visibleValue ?? element.textContent;
            element.dataset.visibleValue = visibleValue;
            element.innerHTML = this.renderFinancialValue(visibleValue, isVisible);
        });
        document.querySelectorAll('[data-financial-toggle]').forEach(card => {
            card.classList.toggle('is-values-hidden', !isVisible);
            card.setAttribute('aria-pressed', String(!isVisible));
            card.setAttribute('title', isVisible ? 'Clique para ocultar os valores' : 'Clique para mostrar os valores');
        });
    },

    setFinancialValue(id, value) {
        const element = document.getElementById(id);
        if (!element) return;
        element.dataset.visibleValue = value;
        element.innerHTML = this.renderFinancialValue(value, this.financialValuesVisible);
    },

    setupAppointmentAlertSound() {
        if (this.appointmentAlertUnlockHandler) return;

        const unlock = () => {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;

            if (!this.appointmentAlertAudioContext) {
                this.appointmentAlertAudioContext = new AudioContext();
            }
            if (this.appointmentAlertAudioContext.state === 'suspended') {
                this.appointmentAlertAudioContext.resume().catch(() => {});
            }

            document.removeEventListener('pointerdown', unlock);
            document.removeEventListener('keydown', unlock);
            document.removeEventListener('touchstart', unlock);
            this.appointmentAlertUnlockHandler = null;
        };

        this.appointmentAlertUnlockHandler = unlock;
        document.addEventListener('pointerdown', unlock, { passive: true });
        document.addEventListener('keydown', unlock, { passive: true });
        document.addEventListener('touchstart', unlock, { passive: true });
    },

    startAppointmentPolling() {
        if (this.appointmentPollingTimer) return;
        if (!['dashboard', 'agenda', 'billing', 'comissoes'].some(permission => auth.can(permission))) return;

        this.appointmentPollingTimer = setInterval(() => {
            if (!auth.user || document.visibilityState === 'hidden') return;
            this.loadData();
        }, 15000);
    },

    playAppointmentAlertSound() {
        const context = this.appointmentAlertAudioContext;
        if (!context || context.state !== 'running') return;

        const now = context.currentTime;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, now);
        oscillator.frequency.setValueAtTime(660, now + 0.16);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.45);
    },

    announceNewAppointments(appointments) {
        const count = appointments.length;
        if (!count) return;

        this.playAppointmentAlertSound();
        auth.notify(
            count === 1 ? 'Um novo agendamento entrou na fila.' : `${count} novos agendamentos entraram na fila.`,
            'info'
        );
    },

    async loadData() {
        try {
            const needsAppointments = ['dashboard', 'agenda', 'billing', 'comissoes'].some(permission => auth.can(permission));
            const needsStats = auth.can('dashboard') || auth.can('billing');
            const statsDate = this.currentDateValue();
            const [statsYear, statsMonth] = statsDate.split('-').map(Number);
            const statsQuery = `?year=${statsYear}&month=${statsMonth}&date=${statsDate}`;
            const [aptRes, statRes] = await Promise.all([
                needsAppointments ? auth.apiRequest(`/api/appointments/${auth.user.id}`) : Promise.resolve(null),
                needsStats ? auth.apiRequest(`/api/stats/${auth.user.id}${statsQuery}`) : Promise.resolve(null)
            ]);

            if (aptRes) {
                const allApts = await aptRes.json();
                const nextPending = this.sortAppointmentsDesc(allApts.filter(a => !['completed', 'canceled', 'no_show'].includes(a.status)));
                const newPending = this.appointmentsInitialized
                    ? nextPending.filter(a => !this.knownPendingAppointmentIds.has(String(a.id)))
                    : [];

                this.allAppointments = allApts;
                this.pending = nextPending;
                this.confirmedAppointmentIds = new Set(
                    nextPending
                        .filter(appointment => appointment.confirmation_sent_at)
                        .map(appointment => String(appointment.id))
                );
                this.knownPendingAppointmentIds = new Set(nextPending.map(a => String(a.id)));
                this.appointmentsInitialized = true;
                if (auth.can('dashboard')) this.renderAppointments();

                if (newPending.length) this.announceNewAppointments(newPending);

                if (agenda.calendar) {
                    agenda.allAppointments = allApts;
                    agenda.renderEvents(allApts);
                }
            }

            if (statRes) {
                const stats = await statRes.json();
                this.dashboardStats = stats;
                if (auth.can('dashboard')) this.updateStats(stats);
            }
        } catch (err) { console.error('Erro ao carregar dados'); }
    },

    money(value) {
        return `R$ ${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    },

    currentDateValue() {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(new Date()).map(part => [part.type, part.value]));
        return `${parts.year}-${parts.month}-${parts.day}`;
    },

    async loadReports() {
        const fromInput = document.getElementById('report-from');
        const toInput = document.getElementById('report-to');
        const currentDate = this.currentDateValue();
        if (fromInput && !fromInput.value) fromInput.value = `${currentDate.slice(0, 7)}-01`;
        if (toInput && !toInput.value) toInput.value = currentDate;
        try {
            const response = await auth.apiRequest(`/api/reports/${auth.user.id}?from=${fromInput.value}&to=${toInput.value}`);
            const data = await response.json();
            this.reportData = data;
            const summary = data.summary || {};
            document.getElementById('report-revenue')?.replaceChildren(this.money(summary.revenue));
            document.getElementById('report-expenses')?.replaceChildren(this.money(summary.expenses));
            document.getElementById('report-profit')?.replaceChildren(this.money(summary.profit));
            document.getElementById('report-commission')?.replaceChildren(this.money(summary.commission));
            const serviceRows = (data.topServices || []).map(item => `<div class="report-breakdown-row"><span>${this.escapeHtml(item.name)} <small>${item.count} atend.</small></span><strong>${this.money(item.total)}</strong></div>`).join('');
            const productRows = (data.topProducts || []).map(item => `<div class="report-breakdown-row"><span>${this.escapeHtml(item.name)} <small>${item.quantity} un.</small></span><strong>${this.money(item.total)}</strong></div>`).join('');
            document.getElementById('report-revenue-breakdown').innerHTML = `<div class="report-breakdown-row"><span>Serviços</span><strong>${this.money(summary.serviceRevenue)}</strong></div><div class="report-breakdown-row"><span>Produtos</span><strong>${this.money(summary.productRevenue)}</strong></div><div class="report-breakdown-row"><span>Atendimentos</span><strong>${summary.serviceCount || 0}</strong></div><div class="report-breakdown-row"><span>Vendas</span><strong>${summary.saleCount || 0}</strong></div><div class="report-breakdown-subtitle">Serviços mais vendidos</div>${serviceRows || '<span class="dashboard-empty-note">Sem atendimentos no período.</span>'}<div class="report-breakdown-subtitle">Produtos mais vendidos</div>${productRows || '<span class="dashboard-empty-note">Sem vendas no período.</span>'}`;
            document.getElementById('report-expenses-breakdown').innerHTML = (data.expensesByCategory || []).length ? data.expensesByCategory.map(item => `<div class="report-breakdown-row"><span>${this.escapeHtml(item.category)}</span><strong>${this.money(item.total)}</strong></div>`).join('') : '<span class="dashboard-empty-note">Nenhuma despesa no período.</span>';
        } catch (error) { console.error('Erro ao carregar relatórios:', error); }
    },

    exportReportsCsv() {
        if (!this.reportData?.summary) return auth.notify('Atualize o relatório antes de exportar.', 'error');
        const summary = this.reportData.summary;
        const rows = [['Indicador', 'Valor'], ['Receita de serviços', summary.serviceRevenue], ['Receita de produtos', summary.productRevenue], ['Receita total', summary.revenue], ['Despesas', summary.expenses], ['Lucro', summary.profit], ['Comissões', summary.commission]];
        (this.reportData.expensesByCategory || []).forEach(item => rows.push([`Despesa - ${item.category}`, item.total]));
        (this.reportData.topServices || []).forEach(item => rows.push([`Serviço - ${item.name}`, item.total, item.count]));
        (this.reportData.topProducts || []).forEach(item => rows.push([`Produto - ${item.name}`, item.total, item.quantity]));
        const csv = rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
        const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `gest-relatorio-${this.currentDateValue()}.csv`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
    },

    openShareModal() {
        const link = `${window.location.origin}/reserva.html?businessId=${auth.user.id}`;
        document.getElementById('share-link-input').value = link;
        this.openModal('share');
    },

    openShareLink() {
        const link = document.getElementById('share-link-input')?.value;
        if (!link) return;
        const newWindow = window.open(link, '_blank', 'noopener,noreferrer');
        if (newWindow) newWindow.opener = null;
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

    showTab(tab, { skipLoading = false } = {}) {
        const permissionByTab = { home: 'dashboard', agenda: 'agenda', billing: 'billing', relatorios: 'relatorios', despesas: 'despesas', clientes: 'clientes', fidelidade: 'clientes', vendas: 'vendas', estoque: 'estoque', barbeiros: 'barbeiros', comissoes: 'comissoes', servicos: 'servicos', configuracoes: 'configuracoes' };
        if (tab === 'administracao' && auth.user?.role !== 'administrador') {
            auth.notify('Acesso exclusivo do administrador.', 'error');
            return;
        }
        if (permissionByTab[tab] && !auth.can(permissionByTab[tab])) {
            auth.notify('Você não possui permissão para esta área.', 'error');
            return;
        }

        if (!skipLoading && this.currentTab === tab && !this.navigationTimer) return;

        this.currentTab = tab;
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        const target = [...document.querySelectorAll('.nav-item')].find(el => el.getAttribute('onclick')?.includes(`showTab('${tab}')`));
        if (target) {
            target.classList.add('active');
            if (target.dataset.sidebarGroup && target.classList.contains('nav-group-item-collapsed')) {
                ui.setNavGroupState(target.dataset.sidebarGroup, true);
            }
        }

        const requestId = ++this.navigationRequestId;
        clearTimeout(this.navigationTimer);

        if (!skipLoading) {
            this.showNavigationLoader(tab);
            this.navigationTimer = setTimeout(() => {
                if (requestId !== this.navigationRequestId) return;
                this.navigationTimer = null;
                try {
                    this.activateTab(tab);
                } finally {
                    this.hideNavigationLoader();
                }
            }, 700);
            return;
        }

        this.navigationTimer = null;
        this.activateTab(tab);
    },

    showNavigationLoader(tab) {
        const loader = document.getElementById('navigation-loader');
        if (!loader) return;

        const labels = {
            home: 'Dashboard',
            agenda: 'Agenda',
            billing: 'Faturamento',
            relatorios: 'Relatórios',
            clientes: 'Clientes',
            fidelidade: 'Fidelidade',
            vendas: 'Vendas',
            estoque: 'Estoque',
            barbeiros: 'Barbeiros',
            comissoes: 'Comissões',
            servicos: 'Serviços',
            configuracoes: 'Ajustes',
            administracao: 'Administração'
        };
        const label = loader.querySelector('[data-navigation-label]');
        if (label) label.textContent = labels[tab] || 'sua área';
        loader.classList.remove('is-visible');
        void loader.offsetWidth;
        loader.classList.add('is-visible');
        loader.setAttribute('aria-hidden', 'false');
    },

    hideNavigationLoader() {
        const loader = document.getElementById('navigation-loader');
        if (!loader) return;
        loader.classList.remove('is-visible');
        loader.setAttribute('aria-hidden', 'true');
    },

    activateTab(tab) {
        // Tab display logic
        const tabs = ['home', 'agenda', 'clientes', 'fidelidade', 'vendas', 'estoque', 'barbeiros', 'servicos', 'configuracoes', 'comissoes', 'billing', 'relatorios', 'despesas', 'administracao'];
        tabs.forEach(t => {
            const el = document.getElementById(`tab-${t}`);
            if (el) el.classList.toggle('hidden', t !== tab);
        });

        // The welcome/date header belongs exclusively to the dashboard home.
        document.querySelector('.dashboard-header')?.classList.toggle('hidden', tab !== 'home');

        if (window.innerWidth <= 1024) {
            document.getElementById('sidebar')?.classList.remove('open');
            document.querySelector('.sidebar-scrim')?.classList.remove('open');
        }

        if (tab === 'billing') {
            this.loadBillingData();
        }
        if (tab === 'relatorios') {
            this.loadReports();
        }

        // Toggle "Link Público" button - only show on home tab
        const linkBtn = document.getElementById('public-link-btn');
        if (linkBtn) {
            linkBtn.classList.toggle('hidden', tab !== 'home');
            linkBtn.onclick = () => window.open(`reserva.html?businessId=${auth.user.id}`, '_blank');
        }

        if (tab === 'agenda') {
            agenda.init();
            this.loadWaitlist();
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
        if (tab === 'fidelidade') {
            this.loadLoyalty();
        }
        if (tab === 'administracao') {
            this.openAdminPanel('overview');
            this.loadUsers();
        }
        if (tab === 'vendas') {
            this.loadInventory(); // Load items for the sales modal
            this.loadSales();
        }
        if (tab === 'despesas') {
            this.loadExpenses();
        }
        if (tab === 'estoque') {
            this.loadInventory();
        }



        if (tab === 'barbeiros') {
            this.loadProfessionals();
        }

        if (tab === 'servicos') {
            this.loadServices();
        }

        if (tab === 'configuracoes') {
            this.loadBookingSettings();
        }

        if (tab === 'comissoes') {
            this.loadSales().then(() => this.loadCommissions());
        }
    },

    openAdminPanel(panel = 'overview', options = {}) {
        const validPanels = ['overview', 'users', 'create', 'marketing', 'logs'];
        const nextPanel = validPanels.includes(panel) ? panel : 'overview';
        const overview = document.getElementById('admin-panel-overview');
        const usersLayout = document.getElementById('admin-users-layout');
        const marketing = document.getElementById('admin-panel-marketing');
        const logs = document.getElementById('admin-panel-logs');
        const createPanel = document.querySelector('[data-admin-content-panel="create"]');
        const usersPanel = document.querySelector('[data-admin-content-panel="users"]');
        const contentPanelVisible = ['users', 'create'].includes(nextPanel);

        overview?.classList.toggle('hidden', nextPanel !== 'overview');
        usersLayout?.classList.toggle('hidden', !contentPanelVisible);
        marketing?.classList.toggle('hidden', nextPanel !== 'marketing');
        logs?.classList.toggle('hidden', nextPanel !== 'logs');
        createPanel?.classList.toggle('hidden', nextPanel !== 'create');
        usersPanel?.classList.toggle('hidden', nextPanel !== 'users');
        this.activeAdminPanel = nextPanel;

        if (nextPanel === 'users') {
            this.loadUsers();
        }

        if (nextPanel === 'marketing') {
            this.loadMarketingLeads();
        }

        if (nextPanel === 'logs') {
            this.loadAuditLogs();
        }

        if (nextPanel === 'create' && options.reset !== false) {
            this.cancelUserEdit();
        }
    },

    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        })[char]);
    },

    async loadUsers() {
        if (auth.user?.role !== 'administrador') return;

        const tbody = document.getElementById('users-table-body');
        if (!tbody) return;

        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 24px;">Carregando usuarios...</td></tr>';

        try {
            const res = await auth.apiRequest('/api/admin/users');
            const data = await res.json();

            if (!data.success) {
                throw new Error(data.message || 'Erro ao carregar usuarios.');
            }

            this.users = data.users;
            const countLabel = document.getElementById('admin-user-count');
            if (countLabel) countLabel.innerText = `${data.users.length} ${data.users.length === 1 ? 'usuário' : 'usuários'}`;
            tbody.innerHTML = data.users.map(user => `
                <tr>
                    <td>
                        <div class="admin-user-identity">
                            <span class="admin-user-avatar">${this.escapeHtml((user.shop_name || 'U').charAt(0).toUpperCase())}</span>
                            <span><strong>${this.escapeHtml(user.shop_name)}</strong><small>${this.escapeHtml(user.email)}</small></span>
                        </div>
                    </td>
                    <td>${user.is_active === false ? '<span class="account-status inactive">Inativo</span>' : '<span class="account-status active">Ativo</span>'}</td>
                    <td><div class="permission-summary">${this.renderPermissionSummary(user)}</div></td>
                    <td>${user.created_at ? new Date(user.created_at).toLocaleDateString('pt-BR') : '--'}</td>
                    <td><div class="admin-user-actions">
                        <button class="btn btn-ghost btn-sm" onclick="admin.editUser(${user.id})">Editar</button>
                        ${user.is_main_admin || String(user.id) === String(auth.user?.id) ? '' : `<button class="btn btn-danger btn-sm" onclick="admin.deleteUser(${user.id})">Excluir</button>`}
                    </div></td>
                </tr>
            `).join('');
        } catch (err) {
            console.error('Load Users Error:', err);
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 24px;">Nao foi possivel carregar os usuarios.</td></tr>';
        }
    },

    async loadMarketingLeads() {
        if (auth.user?.role !== 'administrador') return;

        const tbody = document.getElementById('marketing-leads-table-body');
        if (!tbody) return;

        tbody.innerHTML = '<tr><td colspan="5" class="marketing-leads-empty">Carregando triagens...</td></tr>';

        try {
            const res = await auth.apiRequest('/api/admin/marketing-leads');
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Erro ao carregar triagens.');

            this.marketingLeads = Array.isArray(data.leads) ? data.leads : [];
            const pendingCount = this.marketingLeads.filter(lead => ['new', 'contacted', 'demo_scheduled'].includes(lead.status)).length;
            document.getElementById('marketing-leads-count').textContent = this.marketingLeads.length;
            document.getElementById('marketing-leads-new-count').textContent = pendingCount;

            if (!this.marketingLeads.length) {
                tbody.innerHTML = '<tr><td colspan="5" class="marketing-leads-empty">Nenhuma triagem recebida ainda.</td></tr>';
                return;
            }

            tbody.innerHTML = this.marketingLeads.map(lead => {
                const statusLabels = { new: 'Novo', contacted: 'Contatado', demo_scheduled: 'Demonstração', converted: 'Convertido', lost: 'Perdido', archived: 'Arquivado' };
                const statusLabel = statusLabels[lead.status] || 'Novo';
                const statusClass = lead.status || 'new';
                const phone = this.escapeHtml(lead.phone || '--');
                const receivedAt = lead.created_at ? new Date(lead.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '--';
                const action = lead.status === 'contacted'
                    ? `<button type="button" class="btn btn-ghost btn-sm" onclick="admin.openMarketingLeadWhatsapp(${lead.id})">Abrir WhatsApp</button>`
                    : `<button type="button" class="btn btn-primary btn-sm marketing-whatsapp-btn" onclick="admin.openMarketingLeadWhatsapp(${lead.id})">Chamar no WhatsApp</button>`;

                return `
                    <tr>
                        <td><strong>${this.escapeHtml(lead.name)}</strong><small class="marketing-lead-source">Demonstração pelo site</small></td>
                        <td>${phone}</td>
                        <td>${receivedAt}</td>
                        <td><select class="marketing-lead-status-select" onchange="admin.updateMarketingLead(${lead.id}, this.value)">${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${lead.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select>${lead.next_action_at ? `<small class="marketing-lead-next-action">Próxima ação: ${new Date(lead.next_action_at).toLocaleDateString('pt-BR')}</small>` : ''}</td>
                        <td>${action}</td>
                    </tr>
                `;
            }).join('');
        } catch (err) {
            console.error('Load Marketing Leads Error:', err);
            tbody.innerHTML = '<tr><td colspan="5" class="marketing-leads-empty">Não foi possível carregar as triagens.</td></tr>';
        }
    },

    async loadAuditLogs() {
        const body = document.getElementById('admin-logs-table-body');
        if (!body || auth.user?.role !== 'administrador') return;
        try {
            const response = await auth.apiRequest('/api/admin/audit-logs');
            const data = await response.json();
            body.innerHTML = (data.logs || []).length
                ? data.logs.map(log => `<tr><td>${new Date(log.created_at).toLocaleString('pt-BR')}</td><td>${this.escapeHtml(log.actor_name || log.actor_email || 'Sistema')}</td><td><span class="audit-action-chip">${this.escapeHtml(log.action)}</span></td><td>${this.escapeHtml(log.entity_type || '—')} ${log.entity_id ? `#${log.entity_id}` : ''}</td><td><code>${this.escapeHtml(JSON.stringify(log.metadata || {}))}</code></td></tr>`).join('')
                : '<tr><td colspan="5" class="marketing-leads-empty">Nenhuma atividade registrada ainda.</td></tr>';
        } catch (error) { body.innerHTML = '<tr><td colspan="5" class="marketing-leads-empty">Não foi possível carregar os logs.</td></tr>'; }
    },

    async openMarketingLeadWhatsapp(id) {
        const lead = this.marketingLeads.find(item => Number(item.id) === Number(id));
        if (!lead) return;

        const phone = String(lead.phone || '').replace(/\D/g, '');
        const whatsappPhone = phone.startsWith('55') ? phone : `55${phone}`;
        const message = `Olá, ${lead.name}! Aqui é da equipe Gestano. Recebemos seu pedido de demonstração gratuita. Podemos conversar sobre como organizar melhor a agenda e a rotina da sua barbearia?`;
        const url = `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(message)}`;
        const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
        if (newWindow) newWindow.opener = null;

        if (lead.status !== 'contacted') {
            try {
                await auth.apiRequest(`/api/admin/marketing-leads/${lead.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: 'contacted' })
                });
                lead.status = 'contacted';
                await this.loadMarketingLeads();
            } catch (err) {
                console.error('Erro ao atualizar status da triagem:', err);
            }
        }
    },

    async updateMarketingLead(id, status) {
        const lead = this.marketingLeads.find(item => Number(item.id) === Number(id));
        if (!lead) return;
        try {
            const response = await auth.apiRequest(`/api/admin/marketing-leads/${id}`, { method: 'PATCH', body: JSON.stringify({ status, notes: lead.notes || '' }) });
            const data = await response.json();
            if (!response.ok || data.success === false) throw new Error(data.message || 'Não foi possível atualizar a triagem.');
            await this.loadMarketingLeads();
        } catch (error) { auth.notify(error.message || 'Não foi possível atualizar a triagem.', 'error'); }
    },

    renderPermissionSummary(user) {
        if (user.is_admin) return '<span class="permission-chip admin">Acesso total</span>';

        const labels = {
            dashboard: 'Dashboard', agenda: 'Agenda', billing: 'Faturamento', despesas: 'Despesas', clientes: 'Clientes',
            vendas: 'Vendas', estoque: 'Estoque', barbeiros: 'Equipe', comissoes: 'Comissões', servicos: 'Serviços', configuracoes: 'Ajustes', relatorios: 'Relatórios'
        };
        const enabled = Object.keys(labels).filter(key => user.permissions?.[key] === true);
        if (!enabled.length) return '<span class="permission-chip muted">Sem acesso</span>';

        const visible = enabled.slice(0, 2).map(key => `<span class="permission-chip">${labels[key]}</span>`).join('');
        const remaining = enabled.length - 2;
        return visible + (remaining > 0 ? `<span class="permission-chip muted">+${remaining}</span>` : '');
    },

    setPermissionInputs(permissions = {}, forceAll = false) {
        document.querySelectorAll('#user-permissions-grid input[type="checkbox"]').forEach(input => {
            input.checked = forceAll || permissions[input.value] === true;
            input.disabled = forceAll;
        });
    },

    getSelectedPermissions() {
        return Object.fromEntries(
            [...document.querySelectorAll('#user-permissions-grid input[type="checkbox"]')]
                .map(input => [input.value, input.checked])
        );
    },

    toggleAllPermissions() {
        const inputs = [...document.querySelectorAll('#user-permissions-grid input[type="checkbox"]:not(:disabled)')];
        const shouldSelectAll = inputs.some(input => !input.checked);
        inputs.forEach(input => { input.checked = shouldSelectAll; });
    },

    handleUserRoleChange(role) {
        const isAdmin = role === 'administrador';
        const permissions = this.getSelectedPermissions();
        this.setPermissionInputs(permissions, isAdmin);
    },

    editUser(id) {
        const user = this.users.find(item => item.id === id);
        if (!user) return;

        this.openAdminPanel('create', { reset: false });
        document.getElementById('edit-user-id').value = user.id;
        document.getElementById('new-user-shop').value = user.shop_name || '';
        document.getElementById('new-user-email').value = user.email || '';
        document.getElementById('new-user-password').value = '';
        document.getElementById('new-user-password').placeholder = 'Deixe em branco para manter';
        document.getElementById('new-user-role').value = user.is_admin ? 'administrador' : 'operador';
        document.getElementById('new-user-active').checked = user.is_active !== false;
        this.setPermissionInputs(user.permissions, user.is_admin);
        const isMainAdmin = Boolean(user.is_main_admin || user.email === 'brasil.hyuri@gmail.com');
        document.getElementById('new-user-email').disabled = isMainAdmin;
        document.getElementById('new-user-role').disabled = isMainAdmin;
        document.getElementById('new-user-active').disabled = isMainAdmin;
        document.getElementById('user-form-title').innerText = 'Editar usuário';
        document.getElementById('save-user-btn').innerText = 'Salvar alterações';
        document.getElementById('cancel-edit-user-btn').classList.remove('hidden');
        document.querySelector('.admin-user-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    async deleteUser(id) {
        if (auth.user?.role !== 'administrador') return;

        const user = this.users.find(item => String(item.id) === String(id));
        if (!user) return;
        if (user.is_main_admin || String(user.id) === String(auth.user?.id)) {
            return auth.notify('A conta principal e a conta atual não podem ser excluídas.', 'error');
        }

        const name = this.escapeHtml(user.shop_name || user.email || 'este usuário');
        this.openDeleteConfirm(
            `Deseja excluir a conta <strong>${name}</strong>? Todos os dados vinculados a ela poderão ser afetados. Esta ação não pode ser desfeita.`,
            async () => {
                try {
                    const response = await auth.apiRequest(`/api/admin/users/${id}`, { method: 'DELETE' });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok || data.success === false) {
                        throw new Error(data.message || 'Não foi possível excluir o usuário.');
                    }

                    this.closeModal('delete-confirm');
                    await this.loadUsers();
                    auth.notify('Usuário excluído com sucesso.', 'success');
                } catch (err) {
                    console.error('Erro ao excluir usuário:', err);
                    auth.notify(err.message || 'Não foi possível excluir o usuário.', 'error');
                }
            },
            { requiresTyping: true }
        );
    },

    cancelUserEdit() {
        document.getElementById('edit-user-id').value = '';
        document.getElementById('new-user-shop').value = '';
        document.getElementById('new-user-email').value = '';
        document.getElementById('new-user-password').value = '';
        document.getElementById('new-user-password').placeholder = 'Defina uma senha';
        document.getElementById('new-user-role').value = 'operador';
        document.getElementById('new-user-active').checked = true;
        document.getElementById('new-user-email').disabled = false;
        document.getElementById('new-user-role').disabled = false;
        document.getElementById('new-user-active').disabled = false;
        this.setPermissionInputs({}, false);
        document.getElementById('user-form-title').innerText = 'Novo usuário';
        document.getElementById('save-user-btn').innerText = 'Criar usuário';
        document.getElementById('cancel-edit-user-btn').classList.add('hidden');
    },

    async saveUser() {
        if (auth.user?.role !== 'administrador') return;

        const id = document.getElementById('edit-user-id').value;
        const shopInput = document.getElementById('new-user-shop');
        const emailInput = document.getElementById('new-user-email');
        const passwordInput = document.getElementById('new-user-password');
        const roleInput = document.getElementById('new-user-role');
        const activeInput = document.getElementById('new-user-active');

        const shop = shopInput.value.trim();
        const email = emailInput.value.trim();
        const password = passwordInput.value.trim();
        const role = roleInput.value;
        const permissions = this.getSelectedPermissions();
        const isActive = activeInput.checked;

        if (!shop || !email || (!id && !password)) {
            return auth.notify('Preencha nome da barbearia, e-mail e senha.', 'error');
        }

        try {
            const res = await auth.apiRequest(id ? `/api/admin/users/${id}` : '/api/admin/users', {
                method: id ? 'PATCH' : 'POST',
                body: JSON.stringify({ shop, email, password, role, permissions, isActive })
            });
            const data = await res.json();

            if (!res.ok || !data.success) {
                return auth.notify(data.message || 'Nao foi possivel salvar o usuario.', 'error');
            }

            const savedUser = data.user;
            const isCurrentUser = savedUser && auth.user && String(savedUser.id) === String(auth.user.id);
            if (isCurrentUser) {
                auth.user = {
                    ...auth.user,
                    ...savedUser,
                    shop_name: savedUser.shop_name,
                    role: savedUser.is_admin ? 'administrador' : 'operador'
                };
                authStorage.write('barberpoint_user', JSON.stringify(auth.user));
                auth.applyDashboardAccess();
            }

            this.cancelUserEdit();
            auth.notify(id ? 'Usuario atualizado com sucesso!' : 'Usuario criado com sucesso!', 'success');
            this.openAdminPanel('users');
        } catch (err) {
            console.error('Save User Error:', err);
            auth.notify('Erro ao salvar usuario.', 'error');
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
        const salesData = this.sales || [];

        const commData = this.professionals.map(p => {
            const profApts = (this.allAppointments || []).filter(a => {
                const aDate = new Date(a.appointment_date);
                const isCorrectMonth = aDate.getMonth() === this.selectedCommMonth && aDate.getFullYear() === currentYear;
                return String(a.professional_id) === String(p.id) && a.status === 'completed' && isCorrectMonth;
            });

            const profSales = salesData.filter(s => {
                const sDate = new Date(s.sale_date || s.created_at);
                const isCorrectMonth = sDate.getMonth() === this.selectedCommMonth && sDate.getFullYear() === currentYear;
                return String(s.professional_id) === String(p.id) && isCorrectMonth;
            });

            const serviceGenerated = profApts.reduce((sum, a) => sum + parseFloat(a.service_price || 0), 0);
            const salesGenerated = profSales.reduce((sum, s) => sum + parseFloat(s.total_price || 0), 0);
            
            const totalGenerated = serviceGenerated + salesGenerated;
            
            // Commission calculation
            // Service: % is Shop's part
            const serviceShopShare = serviceGenerated * (parseFloat(p.commission || 0) / 100);
            
            // Sale: % in DB is Professional's part
            const salesProfShare = profSales.reduce((sum, s) => sum + parseFloat(s.commission_value || 0), 0);
            const salesShopShare = salesGenerated - salesProfShare;
            
            const totalShopShare = serviceShopShare + salesShopShare;
            const toProfessional = totalGenerated - totalShopShare;

            totalRevenue += totalGenerated;
            totalCommissions += totalShopShare;
            totalToProfessionals += toProfessional;

            return {
                id: p.id,
                name: p.name,
                initials: p.name.split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map(namePart => namePart[0])
                    .join('')
                    .toUpperCase() || 'BR',
                photoUrl: p.photo_url ? this.escapeHtml(p.photo_url) : '',
                photoAlt: this.escapeHtml(`Foto de ${p.name}`),
                rate: p.commission || 0,
                generated: totalGenerated,
                shopShare: totalShopShare,
                toProfessional
            };
        });

        // Update KPIs
        document.getElementById('comm-total-revenue').innerText = `R$ ${totalRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        document.getElementById('comm-total-due').innerText = `R$ ${totalCommissions.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        document.getElementById('comm-total-prof').innerText = `R$ ${totalToProfessionals.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

        // Render Table
        if (commData.length === 0) {
            container.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 40px; color: var(--text-muted);">Nenhum barbeiro cadastrado para calcular comissões.</td></tr>';
            return;
        }

        container.innerHTML = commData.map(c => `
            <tr onclick="admin.showProfCommDetails(${c.id})" style="cursor: pointer;">
                <td>
                    <div class="commission-photo-cell">
                        <span class="commission-professional-avatar${c.photoUrl ? ' has-photo' : ''}">
                            ${c.photoUrl
                                ? `<img src="${c.photoUrl}" alt="${c.photoAlt}">`
                                : this.escapeHtml(c.initials)}
                        </span>
                    </div>
                </td>
                <td><strong style="color:var(--primary); text-decoration: underline;">${this.escapeHtml(c.name)}</strong></td>
                <td><span class="svc-tag" style="background: #edf7f5; border: 1px solid var(--border-bright);">${c.rate}%</span></td>
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
        const btns = document.querySelectorAll('#commissions-month-selector .month-btn');
        btns.forEach((btn, idx) => {
            btn.classList.toggle('active', idx === this.selectedCommMonth);
        });
    },

    async showProfCommDetails(profId) {
        const prof = this.professionals.find(p => String(p.id) === String(profId));
        if (!prof) return;

        const currentYear = new Date().getFullYear();
        const monthNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
        
        // Ensure sales are loaded
        await this.loadSales();
        
        const profApts = (this.allAppointments || []).filter(a => {
            const aDate = new Date(a.appointment_date);
            const isCorrectMonth = aDate.getMonth() === this.selectedCommMonth && aDate.getFullYear() === currentYear;
            return String(a.professional_id) === String(profId) && a.status === 'completed' && isCorrectMonth;
        });

        const profSales = (this.sales || []).filter(s => {
            const sDate = new Date(s.sale_date || s.created_at);
            const isCorrectMonth = sDate.getMonth() === this.selectedCommMonth && sDate.getFullYear() === currentYear;
            return String(s.professional_id) === String(profId) && isCorrectMonth;
        });

        const svcGen = profApts.reduce((sum, a) => sum + parseFloat(a.service_price || 0), 0);
        const slsGen = profSales.reduce((sum, s) => sum + parseFloat(s.total_price || 0), 0);
        
        const totalGen = svcGen + slsGen;
        
        // Service Shop Share: Prof. commission is Shop's part
        const svcShopShare = svcGen * (parseFloat(prof.commission || 0) / 100);
        
        // Sales Shop Share: Prof. commission is Professional's part
        // So Shop share = Total - commission_value
        const slsProfShare = profSales.reduce((sum, s) => sum + parseFloat(s.commission_value || 0), 0);
        const slsShopShare = slsGen - slsProfShare;
        
        const totalShopShare = svcShopShare + slsShopShare;
        const totalProfShare = totalGen - totalShopShare;

        // Fill modal
        document.getElementById('prof-details-name').innerText = prof.name;
        const detailAvatar = document.getElementById('prof-details-initials');
        const initials = prof.name
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map(namePart => namePart[0])
            .join('')
            .toUpperCase() || 'BR';
        detailAvatar?.classList.toggle('has-photo', Boolean(prof.photo_url));
        detailAvatar?.replaceChildren();
        if (detailAvatar && prof.photo_url) {
            const image = document.createElement('img');
            image.src = prof.photo_url;
            image.alt = `Foto de ${prof.name}`;
            detailAvatar.appendChild(image);
        } else if (detailAvatar) {
            detailAvatar.innerText = initials;
        }
        document.getElementById('prof-details-month').innerText = `${monthNames[this.selectedCommMonth]} ${currentYear}`;
        document.getElementById('prof-details-total-gen').innerText = `R$ ${totalGen.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        document.getElementById('prof-details-shop-share').innerText = `R$ ${totalShopShare.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        document.getElementById('prof-details-prof-share').innerText = `R$ ${totalProfShare.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

        const container = document.getElementById('prof-comm-details-table-body');
        
        // Combined list
        const items = [
            ...profApts.map(a => ({
                date: new Date(a.appointment_date),
                time: a.appointment_time,
                client: a.client_name,
                desc: a.service_name,
                gen: parseFloat(a.service_price || 0),
                shop: parseFloat(a.service_price || 0) * (parseFloat(prof.commission || 0) / 100),
                type: 'Serviço'
            })),
            ...profSales.map(s => ({
                date: new Date(s.sale_date || s.created_at),
                time: new Date(s.sale_date || s.created_at).toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'}),
                client: s.client_name || 'Consumidor',
                desc: `Venda: ${s.item_name}`,
                gen: parseFloat(s.total_price || 0),
                shop: parseFloat(s.total_price || 0) - parseFloat(s.commission_value || 0),
                type: 'Venda'
            }))
        ].sort((a, b) => b.date - a.date);

        container.innerHTML = items.length > 0 ? items.map(i => {
            const profPart = i.gen - i.shop;
            return `
                <tr>
                    <td>${i.date.toLocaleDateString('pt-BR')} ${i.time}</td>
                    <td>${i.client}</td>
                    <td style="color: var(--primary); font-size: 0.85rem;">[${i.type}] ${i.desc}</td>
                    <td style="font-weight: 600;">R$ ${i.gen.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                    <td style="color: var(--danger); font-size: 0.85rem;">R$ ${i.shop.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                    <td style="color: var(--success); font-weight: 700;">R$ ${profPart.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                </tr>
            `;
        }).join('') : '<tr><td colspan="6" style="text-align:center; padding: 30px; color: var(--text-muted);">Nenhum faturamento registrado para este mês.</td></tr>';

        this.openModal('prof-comm-details');
    },

    getAppointmentDateTimeKey(appointment) {
        const date = String(appointment?.appointment_date || '').slice(0, 10);
        const time = String(appointment?.appointment_time || '').slice(0, 8).padEnd(8, '0');
        return `${date}T${time}`;
    },

    sortAppointmentsDesc(appointments = []) {
        return [...appointments].sort((a, b) => {
            const dateTimeComparison = this.getAppointmentDateTimeKey(b).localeCompare(this.getAppointmentDateTimeKey(a));
            if (dateTimeComparison !== 0) return dateTimeComparison;
            return (Number(b.id) || 0) - (Number(a.id) || 0);
        });
    },

    formatAppointmentDate(dateValue) {
        const [year, month, day] = String(dateValue || '').slice(0, 10).split('-');
        return year && month && day ? `${day}/${month}/${year}` : '--/--/----';
    },

    normalizeQueueSearch(value) {
        return String(value || '')
            .toLocaleLowerCase('pt-BR')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, '');
    },

    setQueueSearch(value) {
        this.queueSearchTerm = String(value || '');
        this.renderAppointments();
    },

    formatWhatsApp(phoneValue) {
        const digits = String(phoneValue || '').replace(/\D/g, '');
        if (!digits) return 'WhatsApp não informado';

        const local = digits.startsWith('55') && (digits.length === 12 || digits.length === 13)
            ? digits.slice(2)
            : digits;
        if (local.length === 11) return `+55 (${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
        if (local.length === 10) return `+55 (${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
        return `+${digits}`;
    },

    appointmentStatusLabel(status) {
        return ({ pending: 'Agendado', confirmed: 'Confirmado', arrived: 'Chegou', in_progress: 'Em atendimento', completed: 'Concluído', no_show: 'Faltou', canceled: 'Cancelado' }[status] || status || 'Agendado');
    },

    async setAppointmentStatus(id, status) {
        this.closeAppointmentMenus();
        try {
            const response = await auth.apiRequest(`/api/appointments/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) throw new Error(data.message || 'Não foi possível atualizar o status.');
            await this.loadData();
            if (agenda.calendar) agenda.renderEvents(this.allAppointments || []);
            auth.notify(`Atendimento marcado como ${this.appointmentStatusLabel(status).toLowerCase()}.`, 'success');
        } catch (error) {
            auth.notify(error.message || 'Não foi possível atualizar o atendimento.', 'error');
        }
    },

    async loadWaitlist() {
        try {
            const response = await auth.apiRequest(`/api/waitlist/${auth.user.id}`);
            const data = await response.json();
            const serviceSelect = document.getElementById('waitlist-service');
            if (serviceSelect) {
                const currentValue = serviceSelect.value;
                serviceSelect.innerHTML = `<option value="">Qualquer serviço</option>${(this.services || []).map(service => `<option value="${service.id}">${this.escapeHtml(service.name)}</option>`).join('')}`;
                serviceSelect.value = currentValue;
            }
            this.waitlistEntries = data.entries || [];
            this.renderWaitlist();
        } catch (error) {
            console.error('Erro ao carregar fila de encaixe:', error);
            auth.notify('Não foi possível carregar a fila de encaixe.', 'error');
        }
    },

    renderWaitlist() {
        const container = document.getElementById('waitlist-list');
        if (!container) return;
        const entries = this.waitlistEntries || [];
        if (!entries.length) {
            container.innerHTML = '<span class="dashboard-empty-note">Nenhum cliente aguardando encaixe.</span>';
            return;
        }
        const statusLabels = { waiting: 'Aguardando', contacted: 'Contatado' };
        container.innerHTML = entries.map(entry => `
            <div class="waitlist-item">
                <div><strong>${this.escapeHtml(entry.client_name)}</strong><span>${this.escapeHtml(this.formatWhatsApp(entry.client_phone))}</span><small>${this.escapeHtml(entry.service_name || 'Qualquer serviço')}${entry.desired_date ? ` · ${this.formatAppointmentDate(entry.desired_date)}` : ''}</small></div>
                <div class="waitlist-actions"><span class="appointment-status-chip status-${entry.status}">${statusLabels[entry.status] || entry.status}</span><button type="button" class="btn btn-ghost btn-sm" onclick="admin.contactWaitlist(${entry.id})">WhatsApp</button><button type="button" class="btn-queue-cancel" aria-label="Remover da fila" onclick="admin.updateWaitlist(${entry.id}, 'canceled')">×</button></div>
            </div>
        `).join('');
    },

    async addWaitlistEntry() {
        const name = document.getElementById('waitlist-name')?.value.trim();
        const phone = document.getElementById('waitlist-phone')?.value.trim();
        const serviceId = document.getElementById('waitlist-service')?.value || null;
        const desiredDate = document.getElementById('waitlist-date')?.value || null;
        if (!name || !phone) return auth.notify('Informe nome e WhatsApp para adicionar à fila.', 'error');
        try {
            const response = await auth.apiRequest('/api/waitlist', { method: 'POST', body: JSON.stringify({ clientName: name, clientPhone: phone, serviceId, desiredDate }) });
            const data = await response.json();
            if (!response.ok || data.success === false) throw new Error(data.message || 'Não foi possível cadastrar o encaixe.');
            ['waitlist-name', 'waitlist-phone', 'waitlist-date'].forEach(id => { const input = document.getElementById(id); if (input) input.value = ''; });
            await this.loadWaitlist();
            auth.notify('Cliente adicionado à fila de encaixe.', 'success');
        } catch (error) { auth.notify(error.message || 'Não foi possível cadastrar o encaixe.', 'error'); }
    },

    async updateWaitlist(id, status) {
        try {
            const response = await auth.apiRequest(`/api/waitlist/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
            if (!response.ok) throw new Error('Não foi possível atualizar o encaixe.');
            await this.loadWaitlist();
        } catch (error) { auth.notify(error.message || 'Não foi possível atualizar o encaixe.', 'error'); }
    },

    async contactWaitlist(id) {
        const entry = (this.waitlistEntries || []).find(item => String(item.id) === String(id));
        if (!entry) return;
        const phone = String(entry.client_phone || '').replace(/\D/g, '');
        if (!phone) return auth.notify('Este cliente não possui WhatsApp válido.', 'error');
        const message = `Olá, ${entry.client_name}! Surgiu uma oportunidade de encaixe${entry.service_name ? ` para ${entry.service_name}` : ''} no Gestano. Quer aproveitar este horário?`;
        const newWindow = window.open(`https://wa.me/${phone.startsWith('55') ? phone : `55${phone}`}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
        if (newWindow) newWindow.opener = null;
        await this.updateWaitlist(id, 'contacted');
    },

    renderAppointments() {
        const container = document.getElementById('appointments-list');
        const allPending = this.sortAppointmentsDesc(this.pending || []);
        const searchTerm = this.normalizeQueueSearch(this.queueSearchTerm);
        const phoneSearchTerm = searchTerm.replace(/\D/g, '');
        const queue = allPending.filter(appointment => {
            if (!searchTerm) return true;
            const clientName = this.normalizeQueueSearch(appointment.client_name);
            const phone = String(appointment.client_phone || '').replace(/\D/g, '');
            return clientName.includes(searchTerm) || (phoneSearchTerm && phone.includes(phoneSearchTerm));
        });

        if (allPending.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding: 2rem; color: var(--text-muted);">Tudo pronto! Fila vazia.</div>';
            return;
        }
        if (queue.length === 0) {
            container.innerHTML = '<div class="queue-empty-search">Nenhum atendimento encontrado para essa busca.</div>';
            return;
        }

        const canDeleteAppointments = auth.can('agenda') || auth.can('clientes');
        container.innerHTML = queue.map(a => `
            <div class="appointment-item">
                <div class="client-info">
                    <h4>${this.escapeHtml(a.client_name)}</h4>
                    <p>${this.escapeHtml(a.service_name)} • ${this.formatAppointmentDate(a.appointment_date)} • ${String(a.appointment_time || '').slice(0, 5)}</p>
                    <span class="appointment-status-chip status-${a.status}">${this.appointmentStatusLabel(a.status)}</span>
                    <p class="appointment-contact">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.92z"></path>
                        </svg>
                        <span>${this.formatWhatsApp(a.client_phone)}</span>
                    </p>
                    <div class="professional-badge" style="margin-top: 8px;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                        ${this.escapeHtml(a.professional_name || 'Geral')}
                    </div>
                </div>
                <div class="action-btns">
                    <button type="button" class="btn btn-confirm-appointment${this.confirmedAppointmentIds.has(String(a.id)) ? ' is-confirmed' : ''}"${this.confirmedAppointmentIds.has(String(a.id)) ? ' disabled aria-disabled="true"' : ` onclick="admin.confirmAppointmentWhatsApp(${a.id})"`}>${this.confirmedAppointmentIds.has(String(a.id)) ? 'Confirmado' : 'Confirmar'}</button>
                    <div class="appointment-actions">
                        <button type="button" class="btn appointment-actions-trigger" aria-haspopup="true" aria-expanded="false" aria-controls="appointment-actions-${a.id}" onclick="admin.toggleAppointmentActions(${a.id}, event)">
                            Ações <span class="appointment-actions-chevron" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="m4 6 4 4 4-4"></path></svg></span>
                        </button>
                        <div id="appointment-actions-${a.id}" class="appointment-actions-menu" role="menu" aria-hidden="true">
                            <button type="button" class="appointment-action-menu-item" role="menuitem" onclick="admin.setAppointmentStatus(${a.id}, 'arrived')">
                                <span class="appointment-action-menu-icon is-success" aria-hidden="true">✓</span>
                                <span><strong>Chegou</strong><small>Cliente presente</small></span>
                            </button>
                            <button type="button" class="appointment-action-menu-item" role="menuitem" onclick="admin.setAppointmentStatus(${a.id}, 'no_show')">
                                <span class="appointment-action-menu-icon is-warning" aria-hidden="true">!</span>
                                <span><strong>Faltou</strong><small>Registrar ausência</small></span>
                            </button>
                            <button type="button" class="appointment-action-menu-item" role="menuitem" onclick="admin.closeAppointmentMenus(); admin.completeService(${a.id}, '${String(a.client_name).replace(/'/g, "\\'")}')">
                                <span class="appointment-action-menu-icon is-primary" aria-hidden="true">✓</span>
                                <span><strong>Concluir agora</strong><small>Finalizar atendimento</small></span>
                            </button>
                            <button type="button" class="appointment-action-menu-item is-danger" role="menuitem" onclick="admin.closeAppointmentMenus(); admin.cancelService(${a.id}, '${String(a.client_name).replace(/'/g, "\\'")}')">
                                <span class="appointment-action-menu-icon is-danger" aria-hidden="true">×</span>
                                <span><strong>Cancelar</strong><small>Encerrar este horário</small></span>
                            </button>
                            ${canDeleteAppointments ? `<button type="button" class="appointment-action-menu-item is-danger" role="menuitem" onclick="admin.closeAppointmentMenus(); admin.deleteAppointment(${a.id}, null)">
                                <span class="appointment-action-menu-icon is-delete" aria-hidden="true">⌫</span>
                                <span><strong>Excluir</strong><small>Remover agendamento</small></span>
                            </button>` : ''}
                        </div>
                    </div>
                    <button type="button" class="btn-queue-cancel" aria-label="Cancelar atendimento de ${this.escapeHtml(a.client_name)}" onclick="admin.cancelService(${a.id}, '${String(a.client_name).replace(/'/g, "\\'")}')">×</button>
                </div>
            </div>
        `).join('');
    },

    toggleAppointmentActions(id, event) {
        event?.stopPropagation();
        const menu = document.getElementById(`appointment-actions-${id}`);
        const trigger = event?.currentTarget || document.querySelector(`[aria-controls="appointment-actions-${id}"]`);
        if (!menu) return;

        const willOpen = !menu.classList.contains('is-open');
        this.closeAppointmentMenus();
        if (willOpen) {
            menu.classList.add('is-open');
            menu.setAttribute('aria-hidden', 'false');
            trigger?.setAttribute('aria-expanded', 'true');
        }
    },

    closeAppointmentMenus() {
        document.querySelectorAll('.appointment-actions-menu.is-open').forEach(menu => {
            menu.classList.remove('is-open');
            menu.setAttribute('aria-hidden', 'true');
        });
        document.querySelectorAll('.appointment-actions-trigger[aria-expanded="true"]').forEach(trigger => {
            trigger.setAttribute('aria-expanded', 'false');
        });
    },

    async confirmAppointmentWhatsApp(appointmentId) {
        const appointment = (this.allAppointments || []).find(item => String(item.id) === String(appointmentId))
            || (this.pending || []).find(item => String(item.id) === String(appointmentId));
        if (!appointment) return auth.notify('Agendamento não encontrado.', 'error');

        const phone = String(appointment.client_phone || '').replace(/\D/g, '');
        if (!phone) return auth.notify('Este cliente não possui WhatsApp cadastrado.', 'error');

        const phoneWithCountryCode = phone.startsWith('55') ? phone : `55${phone}`;
        const dateParts = String(appointment.appointment_date || '').slice(0, 10).split('-');
        const appointmentDate = dateParts.length === 3
            ? `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`
            : 'data a confirmar';
        const appointmentTime = String(appointment.appointment_time || '').slice(0, 5) || 'horário a confirmar';
        const professional = appointment.professional_name || 'nossa equipe';
        const message = [
            `Olá, ${appointment.client_name}!`,
            '',
            'Aqui é da Gestano. Passando para confirmar o seu agendamento:',
            '',
            `Data: ${appointmentDate}`,
            `Horário: ${appointmentTime}`,
            `Serviço: ${appointment.service_name || 'atendimento'}`,
            `Profissional: ${professional}`,
            '',
            'Seu horário está reservado especialmente para você. Se precisar remarcar ou tiver algum imprevisto, avise por aqui com antecedência, combinado?',
            '',
            'Será um prazer te atender! Até lá!'
        ].join('\n');

        const newWindow = window.open(`https://wa.me/${phoneWithCountryCode}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
        if (newWindow) newWindow.opener = null;

        try {
            const response = await auth.apiRequest(`/api/appointments/${appointmentId}/confirmation`, { method: 'PATCH' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) {
                throw new Error(data.message || 'Não foi possível salvar a confirmação.');
            }

            this.confirmedAppointmentIds.add(String(appointmentId));
            await this.loadData();
        } catch (err) {
            console.error('Erro ao salvar confirmação do agendamento:', err);
            auth.notify(err.message || 'A mensagem foi aberta, mas a confirmação não foi salva.', 'error');
        }
    },

    confirmCompleteService(id, clientName) {
        document.getElementById('confirm-service-text').innerText = `Confirmar conclusão do serviço para ${clientName}?`;
        this.resetCompletionPaymentChoice();
        const confirmBtn = document.getElementById('btn-do-complete-service');
        confirmBtn.onclick = () => this.executeCompletion(id);
        this.openModal('confirm-service');
    },

    async completeService(id, clientName = null) {
        this.closeAppointmentMenus();
        if (clientName) {
            document.getElementById('confirm-service-text').innerHTML = `Confirmar conclusão do serviço para <strong>${clientName}</strong>?`;
            this.resetCompletionPaymentChoice();
            document.getElementById('btn-do-complete-service').onclick = () => this.executeCompletion(id);
            this.openModal('confirm-service');
            return;
        }
        
        // Basic fallback if no name passed (legacy)
        if (confirm('Finalizar atendimento?')) {
            this.executeCompletion(id);
        }
    },

    resetCompletionPaymentChoice() {
        const paidOption = document.querySelector('input[name="completion-payment"][value="paid"]');
        if (paidOption) paidOption.checked = true;
    },

    async executeCompletion(id) {
        const paymentStatus = document.querySelector('input[name="completion-payment"]:checked')?.value || 'paid';
        const paymentMethod = document.getElementById('completion-payment-method')?.value || 'cash';
        try {
            const res = await auth.apiRequest(`/api/appointments/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'completed', paymentStatus, paymentMethod })
            });
            if (res.ok) {
                this.closeModal('confirm-service');
                this.loadData();
                auth.notify(paymentStatus === 'pending'
                    ? 'Atendimento finalizado. Pendência registrada no cadastro do cliente.'
                    : 'Atendimento finalizado como pago.', 'success');
            } else {
                const data = await res.json().catch(() => ({}));
                auth.notify(data.message || 'Não foi possível finalizar o atendimento.', 'error');
            }
        } catch (err) {
            console.error('Erro ao finalizar serviço:', err);
            auth.notify(err.message || 'Erro ao finalizar serviço.', 'error');
        }
    },

    async cancelService(id, clientName = null) {
        this.closeAppointmentMenus();
        if (clientName) {
            document.getElementById('cancel-service-text').innerHTML = `Deseja cancelar o agendamento de <strong>${clientName}</strong>?`;
            const confirmation = document.getElementById('cancel-service-confirmation');
            const confirmButton = document.getElementById('btn-do-cancel-service');
            if (confirmation) confirmation.value = '';
            if (confirmButton) {
                confirmButton.disabled = true;
                confirmButton.onclick = () => this.executeCancellation(id);
            }
            this.openModal('cancel-service');
            confirmation?.focus();
            return;
        }

        if (confirm('Deseja cancelar este agendamento?')) {
            this.executeCancellation(id);
        }
    },

    validateCancellationConfirmation(value) {
        const button = document.getElementById('btn-do-cancel-service');
        if (button) button.disabled = String(value || '').trim().toUpperCase() !== 'CONFIRMAR';
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
                auth.notify('Hor\u00E1rio cancelado com sucesso.', 'success');
            } else {
                const data = await res.json().catch(() => ({}));
                auth.notify(data.message || 'N\u00E3o foi poss\u00EDvel cancelar o hor\u00E1rio.', 'error');
            }
        } catch (err) { auth.notify('Erro ao cancelar o hor\u00E1rio.', 'error'); }
    },

    updateStats(stats) {
        const formatMoney = value => `R$ ${parseFloat(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        const monthlyRevenue = parseFloat(stats.monthlyRevenue ?? stats.revenue ?? 0);
        const dailyRevenue = parseFloat(stats.dailyRevenue || 0);
        const monthlyExpenses = parseFloat(stats.monthlyExpenses || 0);
        const monthlyProfit = parseFloat(stats.monthlyProfit || (monthlyRevenue - monthlyExpenses));
        const dailyExpenses = parseFloat(stats.dailyExpenses || 0);

        this.setFinancialValue('stat-revenue', formatMoney(monthlyRevenue));
        this.setFinancialValue('stat-revenue-today', `+ ${formatMoney(dailyRevenue)} hoje`);
        this.setFinancialValue('stat-expense', formatMoney(monthlyExpenses));
        this.setFinancialValue('stat-expense-today', `- ${formatMoney(dailyExpenses)} hoje`);
        this.setFinancialValue('stat-profit', formatMoney(monthlyProfit));
        document.getElementById('stat-count').innerText = stats.count || 0;
        document.getElementById('stat-count-today').innerText = `${stats.completedToday ?? 0} hoje`;
        document.getElementById('stat-scheduled-count').innerText = stats.activeMonth ?? this.pending.length;
        document.getElementById('stat-scheduled-today').innerText = `${stats.activeToday ?? 0} hoje`;
        document.getElementById('stat-new-clients').innerText = stats.newClients ?? 0;
        document.getElementById('stat-average-ticket').innerText = `Ticket médio: ${formatMoney(stats.averageTicket || 0)}`;
        document.getElementById('dashboard-active-today').innerText = stats.activeToday ?? 0;
        document.getElementById('dashboard-completed-today').innerText = stats.completedToday ?? 0;
        document.getElementById('dashboard-no-show-today').innerText = stats.noShowToday ?? 0;
        document.getElementById('dashboard-canceled-today').innerText = stats.canceledToday ?? 0;
        const professionalContainer = document.getElementById('dashboard-professional-revenue');
        if (professionalContainer) {
            professionalContainer.innerHTML = (stats.professionalRevenue || []).length
                ? stats.professionalRevenue.map(prof => `<div class="dashboard-professional-row"><span>${this.escapeHtml(prof.name)}</span><strong>${formatMoney(prof.revenue)}</strong></div>`).join('')
                : '<span class="dashboard-empty-note">Sem dados no período.</span>';
        }
    },

    // CRM / Clients Logic
    async loadClients() {
        try {
            const res = await auth.apiRequest(`/api/clients/${auth.user.id}`);
            this.allClients = await res.json();
            this.renderClients(this.allClients);
        } catch (err) { console.error('Erro ao carregar clientes'); }
    },

    async loadLoyalty() {
        try {
            const response = await auth.apiRequest(`/api/loyalty/${auth.user.id}`);
            const data = await response.json();
            this.loyaltyClients = data.clients || [];
            const totalPoints = this.loyaltyClients.reduce((sum, client) => sum + Number(client.loyalty_points || 0), 0);
            document.getElementById('loyalty-client-count')?.replaceChildren(String(this.loyaltyClients.length));
            document.getElementById('loyalty-points-total')?.replaceChildren(String(totalPoints));
            const body = document.getElementById('loyalty-table-body');
            if (!body) return;
            body.innerHTML = this.loyaltyClients.length
                ? this.loyaltyClients.map(client => `<tr><td><strong>${this.escapeHtml(client.name)}</strong></td><td>${this.escapeHtml(client.phone || '--')}</td><td><span class="loyalty-points-pill">${Number(client.loyalty_points || 0)} pts</span></td><td>${this.escapeHtml(client.referral_code || '—')}</td><td><button class="btn btn-ghost btn-sm" onclick="admin.adjustLoyalty(${client.id}, '${String(client.name).replace(/'/g, "\\'")}')">Ajustar pontos</button></td></tr>`).join('')
                : '<tr><td colspan="5" class="table-empty-result">Cadastre clientes para iniciar o programa.</td></tr>';
        } catch (err) { console.error('Erro ao carregar fidelidade:', err); }
    },

    async adjustLoyalty(clientId, clientName) {
        const points = Number(window.prompt(`Pontos para ${clientName} (use negativo para resgatar):`, '10'));
        if (!Number.isInteger(points) || points === 0) return;
        const reason = window.prompt('Motivo do ajuste:', 'Bônus de fidelidade');
        if (!reason) return;
        try {
            const response = await auth.apiRequest('/api/loyalty/adjust', { method: 'POST', body: JSON.stringify({ clientId, points, reason }) });
            const data = await response.json();
            if (!response.ok || data.success === false) throw new Error(data.message || 'Não foi possível ajustar os pontos.');
            await this.loadLoyalty();
            await this.loadClients();
            auth.notify('Pontos atualizados.', 'success');
        } catch (err) { auth.notify(err.message || 'Não foi possível atualizar os pontos.', 'error'); }
    },

    renderClients(clientsList) {
        const container = document.getElementById('clients-table-body');
        if (!container) return;

        const hasClients = (this.allClients || []).length > 0;
        if (!hasClients) {
            container.innerHTML = `
                <tr class="empty-row">
                    <td colspan="8">
                        <div class="empty-state entity-empty-state">
                            <div>
                                <strong>Nenhum cliente cadastrado</strong>
                                <span>Quando um cliente for cadastrado, ele aparecerá aqui com histórico, atendimentos e contato.</span>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

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

        if (sorted.length === 0) {
            container.innerHTML = '<tr><td colspan="8" class="table-empty-result">Nenhum cliente encontrado para esta busca.</td></tr>';
            return;
        }

        container.innerHTML = sorted.map(c => `
            <tr>
                <td><strong style="color:var(--primary); cursor:pointer; text-decoration: underline;" onclick="admin.showClientDetails(${c.id})">${this.escapeHtml(c.name)}</strong></td>
                <td>${this.escapeHtml(c.phone || '--')}</td>
                <td><span style="color:var(--primary)">${formatDate(c.last_service_date, c.scheduled_time)}</span></td>
                <td style="text-align:center">${c.total_appointments || 0}</td>
                <td>${c.days_since_last_service === null || c.days_since_last_service === undefined ? '<span class="client-paid-badge">Novo</span>' : (Number(c.days_since_last_service) >= 90 ? '<span class="client-pending-badge">90+ dias</span>' : (Number(c.days_since_last_service) >= 60 ? '<span class="client-return-badge">60 dias</span>' : (Number(c.days_since_last_service) >= 30 ? '<span class="client-return-badge">30 dias</span>' : '<span class="client-paid-badge">Em dia</span>')))}</td>
                <td><span class="loyalty-points-pill">${Number(c.loyalty_points || 0)} pts</span></td>
                <td style="text-align:center">
                    ${Number(c.pending_payment_count || 0) > 0
                        ? `<span class="client-pending-badge">R$ ${parseFloat(c.pending_payment_total || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>`
                        : '<span class="client-paid-badge">Em dia</span>'}
                </td>
                <td>
                    <div class="client-actions">
                        <button type="button" class="btn btn-ghost client-whatsapp-btn" title="Abrir WhatsApp" aria-label="Abrir WhatsApp de ${this.escapeHtml(c.name)}" onclick="admin.openWhatsAppConfirm(${c.id})">
                            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20.52 3.48A11.86 11.86 0 0 0 12.04 0C5.47 0 .12 5.35.12 11.92c0 2.1.55 4.15 1.6 5.95L0 24l6.28-1.65a11.94 11.94 0 0 0 5.75 1.46h.01c6.57 0 11.92-5.35 11.92-11.92 0-3.18-1.24-6.17-3.44-8.41zM12.04 21.82h-.01a9.9 9.9 0 0 1-5.04-1.38l-.36-.21-3.73.98 1-3.64-.24-.37a9.87 9.87 0 0 1-1.52-5.27C2.14 6.48 6.58 2.04 12.04 2.04c2.65 0 5.14 1.03 7.02 2.91a9.84 9.84 0 0 1 2.9 7.01c0 5.46-4.44 9.9-9.92 9.9z"></path><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.46-2.39-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.06 2.88 1.21 3.07c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.08 1.76-.72 2.01-1.41.25-.69.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35z"></path></svg>
                        </button>
                        <button type="button" class="btn-queue-cancel client-delete-btn" aria-label="Excluir cliente" title="Excluir cliente" onclick="admin.deleteClient(${c.id}, '${c.name.replace(/'/g, "\\'")}')">×</button>
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
            document.getElementById('detail-client-initials').innerText = client.name
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map(namePart => namePart[0])
                .join('')
                .toUpperCase() || 'CL';
            
            // Fill KPIs
            const totalSpent = parseFloat(stats.total_spent || 0);
            const visitCount = parseInt(stats.service_count || 0);
            const avgTicket = visitCount > 0 ? totalSpent / visitCount : 0;
            const pendingTotal = parseFloat(stats.pending_payment_total || 0);
            
            document.getElementById('detail-total-spent').innerText = `R$ ${totalSpent.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
            document.getElementById('detail-visit-count').innerText = visitCount;
            document.getElementById('detail-avg-ticket').innerText = `R$ ${avgTicket.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
            document.getElementById('detail-pending-total').innerText = `R$ ${pendingTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
            
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
            const statusLabels = {
                completed: 'Concluído',
                canceled: 'Cancelado',
                no_show: 'Faltou',
                pending: 'Agendado',
                confirmed: 'Confirmado',
                arrived: 'Chegou',
                in_progress: 'Em atendimento'
            };
            const paymentLabels = { paid: 'Pago', pending: 'Não pago' };
            historyContainer.innerHTML = history.length > 0 ? history.map(h => `
                <tr style="background: #faf9f7">
                    <td style="padding: 15px;">${this.formatAppointmentDate(h.appointment_date)} ${String(h.appointment_time || '').slice(0, 5)}</td>
                    <td style="padding: 15px;">${h.service_name}</td>
                    <td style="padding: 15px; color: var(--primary); font-weight: 600;">${h.professional_name || 'Geral'}</td>
                    <td style="padding: 15px;">R$ ${parseFloat(h.service_price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                    <td style="padding: 15px;"><span class="status-badge ${{ completed: 'status-ok', confirmed: 'status-ok', arrived: 'status-ok', in_progress: 'status-ok', canceled: 'status-danger', no_show: 'status-danger', pending: 'status-warn' }[h.status] || 'status-warn'}">${statusLabels[h.status] || h.status}</span></td>
                    <td style="padding: 15px;"><span class="status-badge ${h.status !== 'completed' ? 'status-warn' : (h.payment_status === 'pending' ? 'status-danger' : 'status-ok')}">${h.status !== 'completed' ? 'Não aplicável' : (paymentLabels[h.payment_status] || 'Pago')}</span></td>
                    <td style="padding: 15px; text-align: center;">
                        <div class="client-history-actions">
                            ${h.status === 'completed' && h.payment_status === 'pending' ? `<button class="btn btn-ghost btn-sm pending-payment-action" onclick="admin.markAppointmentPaid(${h.id}, ${clientId})">PAGO</button>` : ''}
                            <button class="btn-queue-cancel" aria-label="Excluir atendimento" onclick="admin.deleteAppointment(${h.id}, ${clientId})">×</button>
                        </div>
                    </td>
                </tr>
            `).join('') : '<tr><td colspan="7" style="text-align:center; padding: 30px; color: var(--text-muted);">Nenhum atendimento realizado ainda.</td></tr>';
            
            this.openModal('client-details');
        } catch (err) {
            console.error('Erro ao buscar detalhes do cliente', err);
            alert('Erro ao carregar histórico do cliente');
        }
    },

    markAppointmentPaid(appointmentId, clientId) {
        const confirmationInput = document.getElementById('payment-confirmation');
        const confirmButton = document.getElementById('btn-do-payment-confirm');
        const confirmationText = document.getElementById('payment-confirm-text');

        if (confirmationText) confirmationText.innerText = 'Confirme o recebimento deste atendimento para remover a pendência.';
        if (confirmationInput) {
            confirmationInput.value = '';
            confirmationInput.oninput = () => {
                confirmationInput.value = confirmationInput.value.toUpperCase();
                this.validatePaymentConfirmation(confirmationInput.value);
            };
        }
        if (confirmButton) {
            confirmButton.disabled = true;
            confirmButton.onclick = () => this.executePaymentConfirmation(appointmentId, clientId);
        }

        this.openModal('payment-confirm');
        setTimeout(() => confirmationInput?.focus(), 0);
    },

    validatePaymentConfirmation(value) {
        const button = document.getElementById('btn-do-payment-confirm');
        if (button) button.disabled = String(value || '').trim().toUpperCase() !== 'CONFIRMAR';
    },

    async executePaymentConfirmation(appointmentId, clientId) {
        try {
            const response = await auth.apiRequest(`/api/appointments/${appointmentId}/payment`, { method: 'PATCH' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) {
                throw new Error(data.message || 'Não foi possível confirmar o pagamento.');
            }

            this.closeModal('payment-confirm');
            await this.loadClients();
            await this.showClientDetails(clientId);
            auth.notify('Pagamento confirmado e pendência removida.', 'success');
        } catch (err) {
            console.error('Erro ao confirmar pagamento:', err);
            auth.notify(err.message || 'Não foi possível confirmar o pagamento.', 'error');
        }
    },

    async deleteClient(id, name) {
        this.openDeleteConfirm(`Deseja remover o cliente <strong>${name}</strong> e todo o seu histórico? Esta ação é irreversível.`, async () => {
            try {
                const res = await auth.apiRequest(`/api/clients/${id}`, { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data.success === false) {
                    throw new Error(data.message || 'Não foi possível excluir o cliente.');
                }

                this.allClients = (this.allClients || []).filter(client => String(client.id) !== String(id));
                this.renderClients(this.allClients);
                await this.loadClients();
                await this.loadData();
                this.closeModal('client-details');
                this.closeModal('delete-confirm');
                auth.notify('Cliente removido com sucesso!', 'success');
            } catch (err) {
                console.error('Erro ao excluir cliente:', err);
                auth.notify(err.message || 'Erro ao excluir cliente.', 'error');
            }
        }, { requiresTyping: true });
    },

    async deleteAppointment(id, clientId) {
        this.closeAppointmentMenus();
        this.openDeleteConfirm('Deseja excluir este registro de atendimento permanentemente?', async () => {
            try {
                const response = await auth.apiRequest(`/api/appointments/${id}`, { method: 'DELETE' });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || data.success === false) {
                    throw new Error(data.message || 'Não foi possível excluir o agendamento.');
                }
                if (clientId) await this.showClientDetails(clientId);
                await this.loadData();
                this.closeModal('delete-confirm');
                auth.notify('Agendamento excluído com sucesso.', 'success');
            } catch (err) {
                console.error('Erro ao excluir atendimento:', err);
                auth.notify(err.message || 'Erro ao excluir atendimento.', 'error');
            }
        }, { requiresTyping: true });
    },

    openDeleteConfirm(text, onConfirm, { requiresTyping = false } = {}) {
        document.getElementById('delete-confirm-text').innerHTML = text;
        const btn = document.getElementById('btn-do-delete');
        const confirmationField = document.getElementById('delete-confirmation-field');
        const confirmationInput = document.getElementById('delete-confirmation');

        confirmationField?.classList.toggle('hidden', !requiresTyping);
        if (confirmationInput) {
            confirmationInput.value = '';
            confirmationInput.oninput = () => {
                confirmationInput.value = confirmationInput.value.toUpperCase();
                this.validateDeleteConfirmation(confirmationInput.value);
            };
        }

        btn.disabled = requiresTyping;
        btn.onclick = async () => {
            if (requiresTyping && confirmationInput?.value.trim().toUpperCase() !== 'CONFIRMAR') return;
            await onConfirm();
        };
        this.openModal('delete-confirm');

        if (requiresTyping) {
            setTimeout(() => confirmationInput?.focus(), 0);
        }
    },

    validateDeleteConfirmation(value) {
        const button = document.getElementById('btn-do-delete');
        if (button) button.disabled = String(value || '').trim().toUpperCase() !== 'CONFIRMAR';
    },

    openWhatsAppConfirm(clientId) {
        const client = (this.allClients || []).find(item => String(item.id) === String(clientId));
        if (!client) return auth.notify('Cliente não encontrado.', 'error');

        const phone = String(client.phone || '').replace(/\D/g, '');
        if (!phone) return auth.notify('Este cliente não possui WhatsApp cadastrado.', 'error');

        const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[character]));

        document.getElementById('whatsapp-confirm-text').innerHTML =
            `Deseja abrir uma conversa com <strong>${escapeHtml(client.name)}</strong> no WhatsApp?`;

        const button = document.getElementById('btn-do-whatsapp');
        button.onclick = () => {
            const preferredService = client.preferred_service ? ` de ${client.preferred_service}` : '';
            const message = Number(client.days_since_last_service) >= 30
                ? `Olá, ${client.name}! Sentimos sua falta no Gestano. Que tal agendar novamente seu${preferredService}?`
                : `Olá, ${client.name}! Tudo bem? Estamos à disposição para cuidar do seu próximo atendimento.`;
            const newWindow = window.open(`https://wa.me/${phone.startsWith('55') ? phone : `55${phone}`}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
            if (newWindow) newWindow.opener = null;
            this.closeModal('whatsapp-confirm');
        };

        this.openModal('whatsapp-confirm');
    },

    filterClients() {
        const term = document.getElementById('client-search').value.toLowerCase();
        const filtered = this.allClients.filter(c => 
            c.name.toLowerCase().includes(term) || c.phone.includes(term)
        );
        this.renderClients(filtered);
    },

    async saveClient() {
        const name = document.getElementById('modal-client-name').value;
        const phone = document.getElementById('modal-client-phone').value;
        const notes = document.getElementById('modal-client-notes').value;
        const birthday = document.getElementById('modal-client-birthday')?.value || null;
        const referralCode = document.getElementById('modal-client-referral')?.value.trim() || null;

        if (!name) return alert('O nome do cliente é obrigatório');

        try {
            await auth.apiRequest('/api/clients', {
                method: 'POST',
                body: JSON.stringify({ 
                    name, 
                    phone, 
                    notes,
                    birthday,
                    referralCode
                })
            });

            this.closeModal('client');
            await this.loadClients();
            auth.notify('Cliente cadastrado com sucesso!', 'success');
        } catch (err) { 
            console.error('Erro ao salvar cliente:', err);
            alert('Erro ao cadastrar cliente'); 
        }
    },



    // Inventory Logic (REVOLUTIONARY)
    async loadInventory() {
        try {
            const res = await auth.apiRequest(`/api/inventory/${auth.user.id}?t=${Date.now()}`);
            const data = await res.json();
            this.inventory = data;
            this.renderInventory();
        } catch (err) { console.error('Erro ao carregar estoque'); }
    },

    async openInventoryHistory(id, name) {
        try {
            const response = await auth.apiRequest(`/api/inventory/item/${id}/movements`);
            const data = await response.json();
            document.getElementById('inventory-history-title').innerText = `Histórico · ${name}`;
            const body = document.getElementById('inventory-history-body');
            body.innerHTML = (data.movements || []).length
                ? data.movements.map(movement => `<tr><td>${new Date(movement.created_at).toLocaleDateString('pt-BR')}</td><td><span class="inventory-movement-badge movement-${movement.movement_type}">${({ entry: 'Entrada', sale: 'Venda', return: 'Estorno', adjustment: 'Ajuste' }[movement.movement_type] || movement.movement_type)}</span></td><td>${movement.quantity}</td><td>${this.escapeHtml(movement.reason || '—')}</td></tr>`).join('')
                : '<tr><td colspan="4" class="table-empty-result">Nenhuma movimentação encontrada.</td></tr>';
            this.openModal('inventory-history');
        } catch (error) { auth.notify(error.message || 'Não foi possível carregar o histórico.', 'error'); }
    },

    renderInventory() {
        const container = document.getElementById('inventory-grid');
        if (!container) return;

        if (this.inventory.length === 0) {
            container.innerHTML = `
                <div class="inventory-empty-state">
                    <strong>Nenhum produto cadastrado no estoque</strong>
                    <span>Quando um produto for cadastrado, ele aparecerá aqui com quantidade, preço e status.</span>
                    <button class="btn btn-primary" onclick="admin.openModal('inventory')">Começar agora</button>
                </div>
            `;
            return;
        }

        container.innerHTML = this.inventory.map(i => {
            const isLow = i.quantity <= i.min_quantity;
            const badgeClass = isLow ? 'badge-low' : 'badge-ok';
            const badgeText = isLow ? 'Estoque Baixo' : 'Em Estoque';
            
            const maxVal = Math.max(i.min_quantity * 3, i.quantity);
            const progress = (i.quantity / maxVal) * 100;
            
            const photo = i.photo_url || 'https://images.unsplash.com/photo-1512690196236-d5a23223049b?q=80&w=400&auto=format&fit=crop';
            // Escape single quotes for the onclick handler
            const itemNameEscaped = i.item_name.replace(/'/g, "\\'");

            return `
                <div class="inventory-card">
                    <div class="inventory-card-actions">
                        <button class="card-action-btn" onclick="admin.openEditInventory(${i.id})">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                        </button>
                        <button class="card-action-btn delete" onclick="admin.deleteInventory(${i.id}, '${itemNameEscaped}')">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                        </button>
                    </div>
                    
                    <span class="inventory-card-badge ${badgeClass}">${badgeText}</span>
                    
                    <div class="inventory-card-img">
                        <img src="${photo}" alt="${i.item_name}" onerror="this.src='https://images.unsplash.com/photo-1593113598332-cd288d649433?q=80&w=400&auto=format&fit=crop'">
                    </div>
                    
                    <div class="inventory-card-body">
                        <h3 class="inventory-card-title">${i.item_name}</h3>
                        <p class="inventory-card-desc">${i.description || 'Nenhuma descrição disponível para este produto.'}</p>
                        
                        <div class="inventory-card-price">
                            R$ ${parseFloat(i.unit_price || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                        </div>

                        <div class="inventory-card-qty-control">
                            <button class="qty-btn" onclick="admin.updateQty(${i.id}, -1)">-</button>
                            <div class="qty-value">${i.quantity} <small>${i.unit || 'un'}</small></div>
                            <button class="qty-btn" onclick="admin.updateQty(${i.id}, 1)">+</button>
                        </div>
                        
                        <div class="stock-progress-container">
                            <div class="stock-progress-bar" style="width: ${progress}%; background: ${isLow ? 'var(--danger)' : 'var(--success)'}"></div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    },

    openEditInventory(id) {
        const item = this.inventory.find(i => String(i.id) === String(id));
        if (!item) return;

        document.getElementById('modal-inv-edit-id').value = id;
        document.getElementById('modal-inv-name').value = item.item_name;
        document.getElementById('modal-inv-desc').value = item.description || '';
        document.getElementById('modal-inv-supplier').value = item.supplier || '';
        document.getElementById('modal-inv-cost').value = item.cost_price || 0;
        document.getElementById('modal-inv-photo').value = item.photo_url || '';
        document.getElementById('modal-inv-photo-file').value = '';
        this.updateInventoryPhotoPreview(item.photo_url || '');
        document.getElementById('modal-inv-qty').value = item.quantity;
        document.getElementById('modal-inv-unit').value = item.unit || 'un';
        document.getElementById('modal-inv-min').value = item.min_quantity;
        document.getElementById('modal-inv-price').value = item.unit_price;
        const commissionCheckbox = document.getElementById('modal-inv-generate-commission');
        if (commissionCheckbox) commissionCheckbox.checked = item.generate_commission !== false;

        const modal = document.getElementById('modal-inventory');
        modal.querySelector('.modal-title').innerText = 'Editar Produto';
        modal.querySelector('.btn-full').innerText = 'Salvar Alterações';

        this.openModal('inventory');
    },

    async deleteInventory(id, name) {
        this.openDeleteConfirm(`Deseja remover <strong>${name}</strong> do seu estoque permanentemente?`, async () => {
            try {
                await auth.apiRequest(`/api/inventory/${id}`, { method: 'DELETE' });
                await this.loadInventory();
                this.closeModal('delete-confirm');
            } catch (err) { alert('Erro ao excluir item do estoque'); }
        });
    },

    async updateQty(id, change) {
        const item = this.inventory.find(i => i.id === id);
        if (!item) return;
        
        const newQty = item.quantity + change;
        if (newQty < 0) return;

        try {
            await auth.apiRequest(`/api/inventory/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ quantity: newQty })
            });
            await this.loadInventory();
        } catch (err) { console.error('Erro ao atualizar quantidade'); }
    },

    async saveInventory() {
        const id = document.getElementById('modal-inv-edit-id').value;
        const itemName = document.getElementById('modal-inv-name').value;
        const description = document.getElementById('modal-inv-desc').value;
        const photoUrl = document.getElementById('modal-inv-photo').value;
        const quantity = parseInt(document.getElementById('modal-inv-qty').value);
        const unit = document.getElementById('modal-inv-unit').value || 'un';
        const minQuantity = parseInt(document.getElementById('modal-inv-min').value);
        const unitPrice = parseFloat(document.getElementById('modal-inv-price').value);
        const supplier = document.getElementById('modal-inv-supplier')?.value.trim() || '';
        const costPrice = parseFloat(document.getElementById('modal-inv-cost')?.value) || 0;
        const generateCommission = document.getElementById('modal-inv-generate-commission')?.checked !== false;

        if(!itemName || isNaN(quantity)) return alert('Nome e Quantidade são obrigatórios');

        try {
            const method = id ? 'PATCH' : 'POST';
            const url = id ? `/api/inventory/${id}` : '/api/inventory';
            
            await auth.apiRequest(url, {
                method,
                body: JSON.stringify({ 
                    itemName, 
                    description,
                    photoUrl,
                    supplier,
                    costPrice,
                    quantity, 
                    unit, 
                    minQuantity: minQuantity || 0,
                    unitPrice: unitPrice || 0,
                    generateCommission
                })
            });

            this.closeModal('inventory');
            await this.loadInventory();
            auth.notify(id ? 'Produto atualizado!' : 'Produto adicionado!', 'success');
        } catch (err) { alert('Erro ao salvar item no estoque'); }
    },

    // Sales Logic
    async loadSales() {
        try {
            const res = await auth.apiRequest(`/api/sales/${auth.user.id}?t=${Date.now()}`);
            this.sales = await res.json();
            this.renderSales();
        } catch (err) { console.error('Erro ao carregar vendas'); }
    },

    renderSales() {
        const container = document.getElementById('sales-history-body');
        if (!container) return;

        if (this.sales.length === 0) {
            container.innerHTML = `
                <tr class="empty-row">
                    <td colspan="7">
                        <div class="empty-state empty-state-sales">
                            <div>
                                <strong>Nenhuma venda registrada</strong>
                                <span>Quando uma venda for lançada, ela aparecerá aqui com cliente, produto, comissão e total.</span>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        container.innerHTML = this.sales.map(s => `
            <tr>
                <td class="sales-date-cell" style="color: var(--text-muted); font-size: 0.8rem;">
                    ${new Date(s.sale_date || s.created_at).toLocaleDateString('pt-BR')} ${new Date(s.sale_date || s.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </td>
                <td style="font-weight: 500;">${s.client_name || '<span style="color: var(--text-muted); font-style: italic;">Consumidor</span>'}</td>
                <td><strong style="color: var(--text-main);">${s.item_name}</strong></td>
                <td><span class="qty-badge" style="background: #f3f4f2; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border);">${s.quantity}</span></td>
                <td>
                    ${s.professional_name 
                        ? `<span class="svc-tag" style="background: #e8f6f3; color: var(--success); border: 1px solid #b9ddd6;">${s.professional_name}</span>`
                        : '<span style="color: var(--text-muted)">-</span>'
                    }
                </td>
                <td style="color: var(--primary); font-weight: 800; font-size: 1.1rem;">R$ ${parseFloat(s.total_price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                <td>
                    <button class="btn-queue-cancel" aria-label="Excluir venda" onclick="admin.deleteSale(${s.id}, '${s.item_name.replace(/'/g, "\\'")}')">×</button>
                </td>
            </tr>
        `).join('');
    },

    async loadExpenses() {
        try {
            const res = await auth.apiRequest(`/api/expenses/${auth.user.id}?t=${Date.now()}`);
            if (!res.ok) throw new Error('Não foi possível carregar as despesas.');
            this.expenses = await res.json();
            this.renderExpenses();
        } catch (err) {
            console.error('Erro ao carregar despesas:', err);
        }
    },

    setExpensePeriod(period) {
        if (!/^\d{4}-\d{2}$/.test(String(period || ''))) return;
        this.selectedExpensePeriod = period;
        this.renderExpenses();
    },

    setExpenseMonth(month) {
        const monthIndex = Number(month);
        if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) return;
        this.selectedExpenseMonth = monthIndex;
        this.selectedExpensePeriod = `${this.selectedExpenseYear}-${String(monthIndex + 1).padStart(2, '0')}`;
        this.updateExpenseMonthUI();
        this.renderExpenses();
    },

    updateExpenseMonthUI() {
        document.querySelectorAll('#expenses-month-selector .billing-month-btn')
            .forEach((button, index) => button.classList.toggle('active', index === this.selectedExpenseMonth));
    },

    formatExpenseDate(value) {
        const [year, month, day] = String(value || '').slice(0, 10).split('-');
        return year && month && day ? `${day}/${month}/${year}` : '--/--/----';
    },

    formatExpensePeriod(period) {
        const [year, month] = String(period || '').split('-').map(Number);
        if (!year || !month) return '--';
        return new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    },

    renderExpenses() {
        const period = this.selectedExpensePeriod || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
        const [periodYear, periodMonth] = period.split('-').map(Number);
        if (periodYear && periodMonth) {
            this.selectedExpenseYear = periodYear;
            this.selectedExpenseMonth = periodMonth - 1;
            this.updateExpenseMonthUI();
        }
        const periodExpenses = (this.expenses || []).filter(expense => String(expense.expense_date || '').slice(0, 7) === period);
        const formatCurrency = value => `R$ ${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        const total = periodExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
        const categoryTotals = periodExpenses.reduce((totals, expense) => {
            const category = expense.category || 'Outros';
            totals[category] = (totals[category] || 0) + Number(expense.amount || 0);
            return totals;
        }, {});
        const topCategory = Object.entries(categoryTotals).sort((first, second) => second[1] - first[1])[0];
        document.getElementById('expenses-total-period')?.replaceChildren(formatCurrency(total));
        document.getElementById('expenses-count-period')?.replaceChildren(String(periodExpenses.length));
        document.getElementById('expenses-top-category')?.replaceChildren(topCategory ? `${topCategory[0]} · ${formatCurrency(topCategory[1])}` : '--');
        document.getElementById('expenses-period-label')?.replaceChildren(this.formatExpensePeriod(period));

        const body = document.getElementById('expenses-table-body');
        if (!body) return;
        if (!periodExpenses.length) {
            body.innerHTML = '<tr><td colspan="6" class="expenses-empty">Nenhuma despesa lançada neste período.</td></tr>';
            return;
        }

        body.innerHTML = periodExpenses.map(expense => `
            <tr>
                <td class="expense-date-cell">${this.formatExpenseDate(expense.expense_date)}</td>
                <td><strong>${this.escapeHtml(expense.description)}</strong></td>
                <td><span class="expense-category-badge">${this.escapeHtml(expense.category || 'Outros')}</span></td>
                <td class="expense-notes-cell">${this.escapeHtml(expense.notes || '—')}</td>
                <td class="expense-value-cell">${formatCurrency(expense.amount)}</td>
                <td class="expense-action-cell">
                    <button class="btn-queue-cancel" aria-label="Excluir despesa" onclick="admin.deleteExpense(${Number(expense.id)})">×</button>
                </td>
            </tr>
        `).join('');
    },

    openExpenseModal() {
        const dateInput = document.getElementById('modal-expense-date');
        const today = new Date();
        const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        if (dateInput) dateInput.value = localDate;
        document.getElementById('modal-expense-description').value = '';
        document.getElementById('modal-expense-category').value = 'Outros';
        document.getElementById('modal-expense-amount').value = '';
        document.getElementById('modal-expense-notes').value = '';
        document.getElementById('modal-expense-payment-method').value = 'cash';
        this.openModal('expense');
        setTimeout(() => document.getElementById('modal-expense-description')?.focus(), 0);
    },

    async saveExpense() {
        const description = document.getElementById('modal-expense-description')?.value.trim();
        const category = document.getElementById('modal-expense-category')?.value || 'Outros';
        const amount = Number(String(document.getElementById('modal-expense-amount')?.value || '').replace(',', '.'));
        const expenseDate = document.getElementById('modal-expense-date')?.value;
        const notes = document.getElementById('modal-expense-notes')?.value.trim() || '';
        const paymentMethod = document.getElementById('modal-expense-payment-method')?.value || 'cash';

        if (!description || !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate || '')) {
            return auth.notify('Informe descrição, valor e data válidos para lançar a despesa.', 'error');
        }

        try {
            const response = await auth.apiRequest('/api/expenses', {
                method: 'POST',
                body: JSON.stringify({ description, category, amount, expenseDate, notes, paymentMethod })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) {
                throw new Error(data.message || 'Não foi possível salvar a despesa.');
            }

            this.selectedExpensePeriod = expenseDate.slice(0, 7);
            this.closeModal('expense');
            await this.loadExpenses();
            auth.notify('Despesa lançada com sucesso.', 'success');
        } catch (err) {
            console.error('Erro ao lançar despesa:', err);
            auth.notify(err.message || 'Não foi possível salvar a despesa.', 'error');
        }
    },

    async deleteExpense(id) {
        const expense = (this.expenses || []).find(item => String(item.id) === String(id));
        const description = this.escapeHtml(expense?.description || 'esta despesa');
        this.openDeleteConfirm(`Deseja excluir a despesa <strong>${description}</strong>? Esta ação não pode ser desfeita.`, async () => {
            try {
                const response = await auth.apiRequest(`/api/expenses/${id}`, { method: 'DELETE' });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || data.success === false) {
                    throw new Error(data.message || 'Não foi possível excluir a despesa.');
                }
                await this.loadExpenses();
                this.closeModal('delete-confirm');
                auth.notify('Despesa excluída com sucesso.', 'success');
            } catch (err) {
                console.error('Erro ao excluir despesa:', err);
                auth.notify(err.message || 'Não foi possível excluir a despesa.', 'error');
            }
        }, { requiresTyping: true });
    },

    setBillingMonth(month) {
        this.selectedBillingMonth = Number(month);
        this.updateBillingMonthUI();
        this.loadBillingData();
    },

    setBillingType(type) {
        this.selectedBillingType = ['all', 'services', 'sales'].includes(type) ? type : 'all';
        const selector = document.getElementById('billing-type-selector');
        if (selector) selector.value = this.selectedBillingType;
        this.loadBillingData();
    },

    updateBillingMonthUI() {
        document.querySelectorAll('#billing-month-selector .billing-month-btn')
            .forEach((button, index) => button.classList.toggle('active', index === this.selectedBillingMonth));
    },

    billingDateParts(value) {
        const raw = String(value || '');
        // Date-only fields (like appointment_date) must stay date-only. Timestamps
        // need to be converted to the local timezone before extracting the day,
        // otherwise a sale near midnight can appear on the following day.
        const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (match) {
            return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;
        return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
    },

    formatMonthlyGoal(amount) {
        const numericAmount = Number(amount || 0);
        return `R$ ${numericAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    },

    updateBillingGoalUI() {
        const goalEl = document.getElementById('billing-goal');
        if (goalEl) goalEl.innerText = this.formatMonthlyGoal(this.monthlyGoal);

        const caption = document.getElementById('billing-goal-caption');
        if (caption) caption.innerText = this.monthlyGoalDefined ? 'Definido pelo gestor' : 'Clique para definir a meta';
    },

    async loadMonthlyGoal(month = this.selectedBillingMonth, year = this.selectedBillingYear) {
        try {
            const res = await auth.apiRequest(`/api/monthly-goals/${auth.user.id}?year=${year}&month=${Number(month) + 1}`);
            if (!res.ok) throw new Error('N\u00E3o foi poss\u00EDvel carregar a meta mensal.');
            const data = await res.json();
            this.monthlyGoal = Number(data.amount) || 0;
            this.monthlyGoalDefined = Boolean(data.defined);
            this.updateBillingGoalUI();
        } catch (err) {
            console.error('Erro ao carregar meta mensal:', err);
        }
    },

    openMonthlyGoalModal() {
        const month = Number.isInteger(this.selectedBillingMonth) ? this.selectedBillingMonth : new Date().getMonth();
        const year = this.selectedBillingYear || new Date().getFullYear();
        const monthNames = ['Janeiro', 'Fevereiro', 'Mar\u00E7o', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        const period = document.getElementById('monthly-goal-period');
        const input = document.getElementById('monthly-goal-amount');

        if (period) period.innerText = `Meta de ${monthNames[month]} ${year}`;
        if (input) {
            input.value = this.monthlyGoal > 0 ? this.monthlyGoal.toFixed(2) : '';
            this.openModal('monthly-goal');
            input.focus();
            input.select();
        } else {
            this.openModal('monthly-goal');
        }
    },

    async saveMonthlyGoal() {
        const input = document.getElementById('monthly-goal-amount');
        const amount = Number(String(input?.value || '').replace(',', '.'));
        const month = Number.isInteger(this.selectedBillingMonth) ? this.selectedBillingMonth : new Date().getMonth();
        const year = this.selectedBillingYear || new Date().getFullYear();

        if (!Number.isFinite(amount) || amount <= 0) {
            return auth.notify('Informe um valor de meta maior que zero.', 'error');
        }

        try {
            const res = await auth.apiRequest(`/api/monthly-goals/${auth.user.id}`, {
                method: 'PUT',
                body: JSON.stringify({ year, month: month + 1, amount })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                return auth.notify(data.message || 'N\u00E3o foi poss\u00EDvel salvar a meta mensal.', 'error');
            }

            this.monthlyGoal = Number(data.amount) || amount;
            this.monthlyGoalDefined = true;
            this.updateBillingGoalUI();
            this.closeModal('monthly-goal');
            auth.notify('Meta mensal salva com sucesso.', 'success');
            await this.loadBillingData();
        } catch (err) {
            auth.notify('Erro ao salvar a meta mensal.', 'error');
        }
    },

    async loadBillingData() {
        const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        const month = Number.isInteger(this.selectedBillingMonth) ? this.selectedBillingMonth : new Date().getMonth();
        const year = new Date().getFullYear();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const servicesData = Array(daysInMonth).fill(0);
        const salesData = Array(daysInMonth).fill(0);

        this.updateBillingMonthUI();
        const monthHeader = document.getElementById('billing-chart-month');
        if (monthHeader) {
            monthHeader.innerText = `${monthNames[month]} ${year}`;
        }

        await this.loadSales();
        await this.loadMonthlyGoal(month, year);

        (this.allAppointments || []).forEach(appointment => {
            if (appointment.status !== 'completed') return;
            const date = this.billingDateParts(appointment.appointment_date);
            if (!date || date.year !== year || date.month !== month) return;
            servicesData[date.day - 1] += parseFloat(appointment.service_price || 0);
        });

        (this.sales || []).forEach(sale => {
            const date = this.billingDateParts(sale.sale_date || sale.created_at);
            if (!date || date.year !== year || date.month !== month) return;
            salesData[date.day - 1] += parseFloat(sale.total_price || 0);
        });

        const type = this.selectedBillingType || 'all';
        const dailyData = servicesData.map((serviceValue, index) => {
            if (type === 'services') return serviceValue;
            if (type === 'sales') return salesData[index];
            return serviceValue + salesData[index];
        });
        const totalMonth = dailyData.reduce((total, value) => total + value, 0);
        const goal = Number(this.monthlyGoal) || 0;
        const remaining = Math.max(0, goal - totalMonth);
        const percent = goal > 0 ? Math.min(100, (totalMonth / goal) * 100) : 0;

        document.getElementById('billing-total-month')?.replaceChildren(`R$ ${totalMonth.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
        const remainingEl = document.getElementById('billing-remaining');
        if (remainingEl) {
            if (goal <= 0) {
                remainingEl.style.color = '';
                remainingEl.innerText = 'R$ 0,00';
            } else {
                remainingEl.style.color = totalMonth >= goal ? 'var(--success)' : '';
                remainingEl.innerText = totalMonth >= goal ? 'Meta Atingida!' : `R$ ${remaining.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
            }
        }
        const statusEl = document.getElementById('billing-goal-status');
        if (statusEl) statusEl.innerText = `${percent.toFixed(1)}% da meta atingida`;

        this.renderBillingChart(dailyData, monthNames[month], type, servicesData, salesData);
    },

    renderBillingChart(data, monthName, type = 'all', servicesData = [], salesData = []) {
        const canvas = document.getElementById('billingDailyChart');
        if (!canvas || typeof Chart === 'undefined') return;
        if (this.billingChart) this.billingChart.destroy();

        document.getElementById('billing-chart-empty')?.classList.add('hidden');
        canvas.classList.remove('hidden');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const styles = getComputedStyle(document.body);
        const chartMuted = styles.getPropertyValue('--text-muted').trim() || '#667085';
        const chartGrid = styles.getPropertyValue('--border').trim() || 'rgba(23, 32, 51, 0.1)';
        const labels = data.map((_, index) => String(index + 1).padStart(2, '0'));
        const typeLabels = { all: 'Todos', services: 'Serviços', sales: 'Vendas' };
        const formatCurrency = value => `R$ ${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        const formatPercent = (value, total) => total > 0
            ? `${((value / total) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
            : '0,0%';
        canvas.parentElement?.querySelector('.billing-custom-tooltip')?.remove();

        const externalTooltipHandler = ({ chart, tooltip }) => {
            const panel = chart.canvas.parentElement;
            if (!panel) return;

            let tooltipEl = panel.querySelector('.billing-custom-tooltip');
            if (!tooltipEl) {
                tooltipEl = document.createElement('div');
                tooltipEl.className = 'billing-custom-tooltip';
                panel.appendChild(tooltipEl);
            }

            if (tooltip.opacity === 0 || !tooltip.dataPoints?.length) {
                tooltipEl.style.display = 'none';
                return;
            }

            const index = tooltip.dataPoints[0].dataIndex;
            const serviceValue = Number(servicesData[index] || 0);
            const salesValue = Number(salesData[index] || 0);
            const dayTotal = serviceValue + salesValue;
            const label = labels[index] || '--';
            const sourceRow = (source, value, percentage, colorClass) => `
                <div class="billing-tooltip-row">
                    <span class="billing-tooltip-swatch ${colorClass}"></span>
                    <span class="billing-tooltip-label">${source}:</span>
                    <strong>${formatCurrency(value)}</strong>
                    <span class="billing-tooltip-percent">(${percentage})</span>
                </div>
            `;

            const tooltipContent = type === 'all'
                ? [
                    `<div class="billing-tooltip-table">${[
                        sourceRow('Serviços', serviceValue, formatPercent(serviceValue, dayTotal), 'services'),
                        sourceRow('Vendas', salesValue, formatPercent(salesValue, dayTotal), 'sales')
                    ].join('')}</div>`,
                    '<div class="billing-tooltip-divider"></div>',
                    `<div class="billing-tooltip-total"><span>Total</span><strong>${formatCurrency(dayTotal)}</strong></div>`
                ].join('')
                : `<div class="billing-tooltip-table">${sourceRow(typeLabels[type] || 'Faturamento', Number(tooltip.dataPoints[0].parsed.y || 0), '100,0%', type)}</div>`;

            tooltipEl.innerHTML = `<div class="billing-tooltip-title">Dia ${label}</div>${tooltipContent}`;

            const element = chart.getDatasetMeta(0).data[index];
            if (!element) return;

            tooltipEl.style.display = 'block';
            tooltipEl.style.visibility = 'hidden';

            const canvasLeft = chart.canvas.offsetLeft;
            const canvasTop = chart.canvas.offsetTop;
            const anchorX = canvasLeft + element.x + (element.width || 0) / 2 + 8;
            const anchorY = canvasTop + element.y;
            const minLeft = canvasLeft + 6;
            const maxLeft = canvasLeft + chart.width - tooltipEl.offsetWidth - 6;
            const left = Math.min(Math.max(anchorX, minLeft), Math.max(minLeft, maxLeft));
            let top = anchorY - tooltipEl.offsetHeight - 10;

            if (top < canvasTop + 6) top = anchorY + 10;

            tooltipEl.style.left = `${left}px`;
            tooltipEl.style.top = `${top}px`;
            tooltipEl.style.visibility = 'visible';
        };

        this.billingChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: `${typeLabels[type] || 'Todos'} — ${monthName}`,
                    data,
                    backgroundColor: 'rgba(26, 167, 143, 0.76)',
                    borderColor: '#148b77',
                    borderWidth: 1,
                    borderRadius: 4,
                    hoverBackgroundColor: '#1aa78f',
                    barPercentage: 0.82,
                    categoryPercentage: 0.82
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 350 },
                onClick: (_event, elements) => {
                    const element = elements?.[0];
                    const index = element?.index ?? element?._index;
                    if (!Number.isInteger(index)) return;
                    this.openBillingDayDetails(index + 1, monthName, type);
                },
                onHover: (event, elements) => {
                    const target = event?.native?.target;
                    if (target) target.style.cursor = elements?.length ? 'pointer' : 'default';
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: false,
                        external: externalTooltipHandler
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: chartGrid },
                        ticks: { color: chartMuted, callback: value => `R$ ${value}` }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: chartMuted, autoSkip: false, maxRotation: 0, minRotation: 0, font: { size: 10 } }
                    }
                }
            }
        });
    },

    openBillingDayDetails(day, monthName, type = 'all') {
        const month = Number.isInteger(this.selectedBillingMonth) ? this.selectedBillingMonth : new Date().getMonth();
        const year = Number.isInteger(this.selectedBillingYear) ? this.selectedBillingYear : new Date().getFullYear();
        const dayNumber = Number(day);
        const matchesDay = value => {
            const date = this.billingDateParts(value);
            return date && date.year === year && date.month === month && date.day === dayNumber;
        };

        const serviceRecords = (this.allAppointments || []).filter(appointment =>
            appointment.status === 'completed' && matchesDay(appointment.appointment_date)
        );
        const salesRecords = (this.sales || []).filter(sale => matchesDay(sale.sale_date || sale.created_at));
        const visibleServices = type === 'sales' ? [] : serviceRecords;
        const visibleSales = type === 'services' ? [] : salesRecords;
        const serviceTotal = visibleServices.reduce((total, appointment) => total + Number(appointment.service_price || 0), 0);
        const salesTotal = visibleSales.reduce((total, sale) => total + Number(sale.total_price || 0), 0);
        const formatCurrency = value => `R$ ${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        const formatTime = value => {
            const date = new Date(value);
            return Number.isNaN(date.getTime())
                ? '--:--'
                : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        };
        const dayLabel = String(dayNumber).padStart(2, '0');
        const typeLabels = { all: 'Todos', services: 'Serviços', sales: 'Vendas' };
        const records = [
            ...visibleServices.map(appointment => ({
                kind: 'service',
                type: 'Serviço',
                time: String(appointment.appointment_time || '').slice(0, 5) || '--:--',
                client: appointment.client_name || 'Cliente não informado',
                description: appointment.service_name || 'Serviço',
                professional: appointment.professional_name || 'Não informado',
                value: Number(appointment.service_price || 0)
            })),
            ...visibleSales.map(sale => ({
                kind: 'sale',
                type: 'Venda',
                time: formatTime(sale.sale_date || sale.created_at),
                client: sale.client_name || 'Consumidor',
                description: `${sale.item_name || 'Produto'}${Number(sale.quantity || 0) > 1 ? ` (${sale.quantity} un.)` : ''}`,
                professional: sale.professional_name || 'Não informado',
                value: Number(sale.total_price || 0)
            }))
        ].sort((first, second) => first.time.localeCompare(second.time));

        document.getElementById('billing-day-details-title')?.replaceChildren(`Detalhes do dia ${dayLabel}`);
        document.getElementById('billing-day-details-period')?.replaceChildren(`${dayLabel} de ${monthName} ${year}`);
        document.getElementById('billing-day-details-filter')?.replaceChildren(typeLabels[type] || 'Todos');
        document.getElementById('billing-day-services-total')?.replaceChildren(formatCurrency(serviceTotal));
        document.getElementById('billing-day-sales-total')?.replaceChildren(formatCurrency(salesTotal));
        document.getElementById('billing-day-total')?.replaceChildren(formatCurrency(serviceTotal + salesTotal));

        const tableBody = document.getElementById('billing-day-details-table-body');
        if (tableBody) {
            tableBody.innerHTML = records.length > 0
                ? records.map(record => `
                    <tr>
                        <td>${this.escapeHtml(record.time)}</td>
                        <td><span class="billing-day-record-type ${record.kind}">${record.type}</span></td>
                        <td>${this.escapeHtml(record.client)}</td>
                        <td>${this.escapeHtml(record.description)}</td>
                        <td>${this.escapeHtml(record.professional)}</td>
                        <td class="billing-day-record-value">${formatCurrency(record.value)}</td>
                    </tr>
                `).join('')
                : '<tr><td colspan="6" class="billing-day-details-empty">Nenhum registro compõe esta barra.</td></tr>';
        }

        this.openModal('billing-day-details');
    },

    async deleteSale(id, itemName) {
        const safeItemName = this.escapeHtml(itemName);
        this.openDeleteConfirm(`Deseja excluir o registro da venda de <strong>${safeItemName}</strong>? O estoque será restaurado automaticamente.`, async () => {
            try {
                const response = await auth.apiRequest(`/api/sales/${id}`, { method: 'DELETE' });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || result.success === false) {
                    throw new Error(result.message || 'Não foi possível excluir a venda.');
                }
                await this.loadSales();
                await this.loadInventory();
                await this.loadData();
                this.closeModal('delete-confirm');
                auth.notify('Venda excluída e estoque restaurado.', 'success');
            } catch (err) {
                console.error('Erro ao excluir venda:', err);
                auth.notify(err.message || 'Erro ao excluir venda.', 'error');
            }
        }, { requiresTyping: true });
    },

    async openSaleModal() {
        if (this.inventory.length === 0) await this.loadInventory();
        if (this.professionals.length === 0) await this.loadProfessionals();
        
        this.clearSelectedItem();
        this.clearSelectedClient();
        this.clearSelectedProfessional();

        document.getElementById('modal-sale-qty').value = 1;
        document.getElementById('modal-sale-price-unit').value = 0;
        if (document.getElementById('modal-sale-price-unit-display')) {
            document.getElementById('modal-sale-price-unit-display').innerText = 'R$ 0,00';
        }
        document.getElementById('modal-sale-total').innerText = 'R$ 0,00';
        document.getElementById('modal-sale-commission').value = 0;
        this.openModal('sales');
    },

    // --- ITEM SELECTION ---
    openSelectItem() {
        this.renderSelectItemTable(this.inventory);
        document.getElementById('select-item-search').value = '';
        this.openModal('select-item');
    },

    renderSelectItemTable(items) {
        const body = document.getElementById('select-item-table-body');
        if (items.length === 0) {
            body.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">Nenhum produto encontrado.</td></tr>';
            return;
        }
        body.innerHTML = items.map(i => {
            const photoUrl = i.photo_url ? this.escapeHtml(i.photo_url) : '';
            const photoAlt = this.escapeHtml(`Imagem de ${i.item_name}`);
            const itemName = this.escapeHtml(i.item_name);
            const category = this.escapeHtml(i.category || 'Geral');
            const itemNameForAction = i.item_name.replace(/'/g, "\\'");

            return `
                <tr>
                    <td>
                        <div class="product-select-photo${photoUrl ? ' has-photo' : ' no-photo'}">
                            ${photoUrl
                                ? `<img src="${photoUrl}" alt="${photoAlt}">`
                                : '<span>Sem foto</span>'}
                        </div>
                        <button class="btn btn-ghost btn-sm inventory-history-button" onclick="admin.openInventoryHistory(${i.id}, '${String(i.item_name).replace(/'/g, "\\'")}')">Ver histórico</button>
                    </td>
                    <td><strong>${itemName}</strong></td>
                    <td><span class="category-badge">${category}</span></td>
                    <td style="color: var(--primary);">R$ ${parseFloat(i.unit_price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                    <td><span class="qty-badge">${i.quantity}</span></td>
                    <td style="text-align: right;">
                        <button class="btn btn-primary btn-sm" onclick="admin.selectItem(${i.id}, '${itemNameForAction}', ${i.unit_price})">Selecionar</button>
                    </td>
                </tr>
            `;
        }).join('');
    },

    filterSelectItem(term) {
        const filtered = this.inventory.filter(i => 
            i.item_name.toLowerCase().includes(term.toLowerCase()) || 
            (i.category && i.category.toLowerCase().includes(term.toLowerCase()))
        );
        this.renderSelectItemTable(filtered);
    },

    selectItem(id, name, price) {
        document.getElementById('modal-sale-item-id').value = id;
        document.getElementById('modal-sale-item-display').innerText = name;
        document.getElementById('modal-sale-item-display').style.color = 'var(--primary)';
        document.getElementById('modal-sale-price-unit').value = price;
        if (document.getElementById('modal-sale-price-unit-display')) {
            document.getElementById('modal-sale-price-unit-display').innerText = 'R$ ' + parseFloat(price).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
        }
        this.calculateSaleTotal();
        this.closeModal('select-item');
    },

    clearSelectedItem() {
        document.getElementById('modal-sale-item-id').value = '';
        document.getElementById('modal-sale-item-display').innerText = 'Selecione um produto...';
        document.getElementById('modal-sale-item-display').style.color = 'var(--text-muted)';
        document.getElementById('modal-sale-price-unit').value = 0;
        if (document.getElementById('modal-sale-price-unit-display')) {
            document.getElementById('modal-sale-price-unit-display').innerText = 'R$ 0,00';
        }
        this.calculateSaleTotal();
        if (document.getElementById('modal-select-item')) this.closeModal('select-item');
    },

    // --- PROFESSIONAL SELECTION ---
    openSelectProfessional() {
        this.renderSelectProfessionalTable(this.professionals);
        document.getElementById('select-professional-search').value = '';
        this.openModal('select-professional');
    },

    renderSelectProfessionalTable(pros) {
        const body = document.getElementById('select-professional-table-body');
        if (pros.length === 0) {
            body.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 20px;">Nenhum barbeiro encontrado.</td></tr>';
            return;
        }
        body.innerHTML = pros.map(p => `
            <tr>
                <td><strong>${p.name}</strong></td>
                <td>${p.specialty || '-'}</td>
                <td style="text-align: right;">
                    <button class="btn btn-primary btn-sm" onclick="admin.selectProfessional(${p.id}, '${p.name.replace(/'/g, "\\'")}', ${p.product_commission || 0})">Selecionar</button>
                </td>
            </tr>
        `).join('');
    },

    filterSelectProfessional(term) {
        const filtered = this.professionals.filter(p => 
            p.name.toLowerCase().includes(term.toLowerCase()) || 
            (p.specialty && p.specialty.toLowerCase().includes(term.toLowerCase()))
        );
        this.renderSelectProfessionalTable(filtered);
    },

    selectProfessional(id, name, rate) {
        document.getElementById('modal-sale-professional-id').value = id;
        document.getElementById('modal-sale-professional-display').innerText = name;
        document.getElementById('modal-sale-professional-display').style.color = 'var(--primary)';
        document.getElementById('modal-sale-commission').value = rate;
        this.closeModal('select-professional');
    },

    clearSelectedProfessional() {
        document.getElementById('modal-sale-professional-id').value = '';
        document.getElementById('modal-sale-professional-display').innerText = 'Nenhum';
        document.getElementById('modal-sale-professional-display').style.color = 'var(--text-muted)';
        document.getElementById('modal-sale-commission').value = 0;
        if (document.getElementById('modal-select-professional')) this.closeModal('select-professional');
    },

    // --- CLIENT SELECTION ---
    openSelectClient() {
        this.renderSelectClientTable(this.allClients);
        document.getElementById('select-client-search').value = '';
        this.openModal('select-client');
    },

    renderSelectClientTable(clients) {
        const body = document.getElementById('select-client-table-body');
        if (clients.length === 0) {
            body.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 20px;">Nenhum cliente encontrado.</td></tr>';
            return;
        }
        body.innerHTML = clients.map(c => `
            <tr>
                <td><strong>${c.name}</strong></td>
                <td>${c.phone || '-'}</td>
                <td style="text-align: right;">
                    <button class="btn btn-primary btn-sm" onclick="admin.selectClient(${c.id}, '${c.name.replace(/'/g, "\\'")}')">Selecionar</button>
                </td>
            </tr>
        `).join('');
    },

    filterSelectClient(term) {
        const filtered = this.allClients.filter(c => 
            c.name.toLowerCase().includes(term.toLowerCase()) || 
            (c.phone && c.phone.includes(term))
        );
        this.renderSelectClientTable(filtered);
    },

    selectClient(id, name) {
        document.getElementById('modal-sale-client-id').value = id;
        document.getElementById('modal-sale-client-display').innerText = name;
        document.getElementById('modal-sale-client-display').style.color = 'var(--primary)';
        this.closeModal('select-client');
    },

    clearSelectedClient() {
        document.getElementById('modal-sale-client-id').value = '';
        document.getElementById('modal-sale-client-display').innerText = 'Consumidor Final';
        document.getElementById('modal-sale-client-display').style.color = 'var(--text-muted)';
        if (document.getElementById('modal-select-client')) this.closeModal('select-client');
    },

    calculateSaleTotal() {
        const qty = parseInt(document.getElementById('modal-sale-qty').value) || 0;
        const price = parseFloat(document.getElementById('modal-sale-price-unit').value) || 0;
        const total = qty * price;
        document.getElementById('modal-sale-total').innerText = `R$ ${total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    },

    async saveSale() {
        const inventoryId = document.getElementById('modal-sale-item-id').value;
        const clientId = document.getElementById('modal-sale-client-id').value;
        const professionalId = document.getElementById('modal-sale-professional-id').value;
        const quantity = parseInt(document.getElementById('modal-sale-qty').value) || 0;
        const unitPrice = parseFloat(document.getElementById('modal-sale-price-unit').value) || 0;
        const commissionRate = parseFloat(document.getElementById('modal-sale-commission').value) || 0;
        const paymentMethod = document.getElementById('modal-sale-payment-method')?.value || 'cash';
        
        if (!inventoryId || quantity <= 0) return alert('Selecione um produto e a quantidade.');

        const totalPrice = quantity * unitPrice;

        try {
            await auth.apiRequest('/api/sales', {
                method: 'POST',
                body: JSON.stringify({ 
                    barberId: auth.user.id,
                    inventoryId, 
                    clientId: clientId || null, 
                    professionalId: professionalId || null, 
                    quantity,
                    unitPrice,
                    totalPrice,
                    commissionRate,
                    paymentMethod
                })
            });
            await this.loadSales();
            await this.loadInventory();
            await this.loadData();
            if (!document.getElementById('tab-billing')?.classList.contains('hidden')) {
                await this.loadBillingData();
            }
            this.closeModal('sales');
            auth.notify('Venda registrada com sucesso!', 'success');
        } catch (err) { alert('Erro ao registrar venda: ' + err.message); }
    },

    // Professionals Management
    async loadProfessionals() {
        try {
            const res = await auth.apiRequest(`/api/professionals/${auth.user.id}`);
            this.professionals = await res.json();
            this.renderProfessionals();
            if (agenda.calendar) agenda.populateProfessionalFilter();
        } catch (err) { console.error('Erro ao carregar barbeiros'); }
    },

    renderProfessionals() {
        const container = document.getElementById('professionals-grid');
        if (!container) return;
        
        if (this.professionals.length === 0) {
            container.innerHTML = `
                <div class="glass" style="grid-column: 1/-1; padding: 4rem; text-align: center; border: 2px dashed var(--border);">
                    <p style="color: var(--text-muted); font-size: 1.1rem;">Nenhum barbeiro cadastrado ainda.</p>
                    <button class="btn btn-primary" onclick="admin.openModal('professional')" style="margin-top: 1.5rem; display: inline-flex;">Começar agora</button>
                </div>
            `;
            return;
        }

        container.innerHTML = this.professionals.map(p => {
            const initials = p.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
            const services = p.services || [];
            const photoUrl = p.photo_url ? this.escapeHtml(p.photo_url) : '';
            const photoAlt = this.escapeHtml(`Foto de ${p.name}`);
            
            return `
                <div class="professional-card">
                    <div class="prof-card-header">
                        <div class="prof-card-avatar${photoUrl ? ' has-photo' : ''}">
                            ${photoUrl ? `<img src="${photoUrl}" alt="${photoAlt}">` : initials}
                        </div>
                        <div class="prof-card-info" style="flex: 1; min-width: 0;">
                            <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                                <h3 style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.name}</h3>
                            </div>
                            <p>${p.phone || 'Sem contato'}</p>
                        </div>
                    </div>
                    <div class="prof-commission-strip">
                        <span>Servi&ccedil;os <strong>${parseFloat(p.commission || 0).toLocaleString('pt-BR')}%</strong></span>
                        <span>Produtos <strong>${parseFloat(p.product_commission || 0).toLocaleString('pt-BR')}%</strong></span>
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

    setupProfessionalPhotoPicker() {
        const fileInput = document.getElementById('modal-prof-photo-file');
        if (!fileInput || fileInput.dataset.bound === 'true') return;

        fileInput.dataset.bound = 'true';
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                auth.notify('Selecione uma imagem JPG, PNG ou WEBP.', 'error');
                fileInput.value = '';
                return;
            }

            if (file.size > 5 * 1024 * 1024) {
                auth.notify('A foto precisa ter no máximo 5 MB.', 'error');
                fileInput.value = '';
                return;
            }

            try {
                const photoUrl = await this.prepareProfessionalPhoto(file);
                this.openProfessionalPhotoEditor(photoUrl);
            } catch (err) {
                console.error('Erro ao preparar foto do barbeiro:', err);
                auth.notify('Não foi possível preparar essa foto.', 'error');
                fileInput.value = '';
            }
        });

        document.getElementById('modal-prof-photo-clear')?.addEventListener('click', () => {
            this.requestPhotoRemoval('professional');
        });

        document.getElementById('modal-prof-photo-edit')?.addEventListener('click', () => {
            const photoUrl = document.getElementById('modal-prof-photo')?.value;
            if (photoUrl) this.openProfessionalPhotoEditor(photoUrl);
        });

        document.getElementById('modal-prof-photo-cancel')?.addEventListener('click', () => {
            this.closeProfessionalPhotoEditor();
        });

        document.getElementById('modal-prof-photo-apply')?.addEventListener('click', () => {
            this.applyProfessionalPhotoCrop();
        });

        document.getElementById('modal-prof-photo-zoom')?.addEventListener('input', (event) => {
            this.professionalPhotoCrop.zoom = Number(event.target.value) || 1;
            this.renderProfessionalPhotoCrop();
        });

        const cropFrame = document.getElementById('modal-prof-photo-crop-frame');
        cropFrame?.addEventListener('pointerdown', (event) => {
            const crop = this.professionalPhotoCrop;
            if (!crop.image) return;
            event.preventDefault();
            crop.dragging = true;
            crop.startX = event.clientX;
            crop.startY = event.clientY;
            crop.startOffsetX = crop.offsetX;
            crop.startOffsetY = crop.offsetY;
            cropFrame.classList.add('is-dragging');
            cropFrame.setPointerCapture?.(event.pointerId);
        });

        cropFrame?.addEventListener('pointermove', (event) => {
            const crop = this.professionalPhotoCrop;
            if (!crop.dragging) return;
            crop.offsetX = crop.startOffsetX + event.clientX - crop.startX;
            crop.offsetY = crop.startOffsetY + event.clientY - crop.startY;
            this.renderProfessionalPhotoCrop();
        });

        const stopPhotoDrag = () => {
            this.professionalPhotoCrop.dragging = false;
            cropFrame?.classList.remove('is-dragging');
        };
        cropFrame?.addEventListener('pointerup', stopPhotoDrag);
        cropFrame?.addEventListener('pointercancel', stopPhotoDrag);

        document.getElementById('modal-prof-name')?.addEventListener('input', () => {
            if (!document.getElementById('modal-prof-photo').value) this.updateProfessionalPhotoPreview('');
        });
    },

    prepareProfessionalPhoto(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('Falha ao ler o arquivo'));
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(file);
        });
    },

    requestPhotoRemoval(type) {
        const photoConfig = {
            professional: {
                label: 'a foto do perfil do barbeiro',
                fileId: 'modal-prof-photo-file',
                valueId: 'modal-prof-photo',
                clearPreview: () => this.updateProfessionalPhotoPreview('')
            },
            service: {
                label: 'a imagem do servi\u00E7o',
                fileId: 'modal-svc-photo-file',
                valueId: 'modal-svc-photo',
                clearPreview: () => this.updateServicePhotoPreview('')
            },
            inventory: {
                label: 'a imagem do produto',
                fileId: 'modal-inv-photo-file',
                valueId: 'modal-inv-photo',
                clearPreview: () => this.updateInventoryPhotoPreview('')
            }
        }[type];

        if (!photoConfig) return;

        this.openDeleteConfirm(
            `Deseja remover ${photoConfig.label}? A altera\u00E7\u00E3o ser\u00E1 aplicada ao salvar.`,
            () => {
                document.getElementById(photoConfig.fileId).value = '';
                document.getElementById(photoConfig.valueId).value = '';
                photoConfig.clearPreview();
                this.closeModal('delete-confirm');
                auth.notify('Imagem removida do formul\u00E1rio.', 'success');
            },
            { requiresTyping: true }
        );
    },

    openProfessionalPhotoEditor(photoUrl) {
        const editor = document.getElementById('modal-prof-photo-editor');
        const cropImage = document.getElementById('modal-prof-photo-crop-image');
        if (!editor || !cropImage || !photoUrl) return;

        const image = new Image();
        image.onerror = () => auth.notify('Não foi possível abrir essa foto para enquadramento.', 'error');
        image.onload = () => {
            this.professionalPhotoCrop = {
                ...this.professionalPhotoCrop,
                image,
                sourceUrl: photoUrl,
                zoom: 1,
                offsetX: 0,
                offsetY: 0,
                dragging: false
            };
            cropImage.src = photoUrl;
            editor.classList.remove('hidden');
            const zoomInput = document.getElementById('modal-prof-photo-zoom');
            if (zoomInput) zoomInput.value = '1';
            this.renderProfessionalPhotoCrop();
        };
        image.src = photoUrl;
    },

    closeProfessionalPhotoEditor() {
        document.getElementById('modal-prof-photo-editor')?.classList.add('hidden');
        const cropImage = document.getElementById('modal-prof-photo-crop-image');
        if (cropImage) cropImage.removeAttribute('src');
        this.professionalPhotoCrop.image = null;
        this.professionalPhotoCrop.dragging = false;
    },

    renderProfessionalPhotoCrop() {
        const crop = this.professionalPhotoCrop;
        const frame = document.getElementById('modal-prof-photo-crop-frame');
        const image = document.getElementById('modal-prof-photo-crop-image');
        if (!crop.image || !frame || !image) return;

        const frameSize = frame.clientWidth || 240;
        const baseScale = Math.max(frameSize / crop.image.naturalWidth, frameSize / crop.image.naturalHeight);
        const scale = baseScale * crop.zoom;
        const displayWidth = crop.image.naturalWidth * scale;
        const displayHeight = crop.image.naturalHeight * scale;
        const maxOffsetX = Math.max(0, (displayWidth - frameSize) / 2);
        const maxOffsetY = Math.max(0, (displayHeight - frameSize) / 2);

        crop.offsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, crop.offsetX));
        crop.offsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, crop.offsetY));

        image.style.width = `${displayWidth}px`;
        image.style.height = `${displayHeight}px`;
        image.style.transform = `translate3d(calc(-50% + ${crop.offsetX}px), calc(-50% + ${crop.offsetY}px), 0)`;

        const zoomValue = document.getElementById('modal-prof-photo-zoom-value');
        if (zoomValue) zoomValue.value = `${Math.round(crop.zoom * 100)}%`;
        if (zoomValue) zoomValue.innerText = `${Math.round(crop.zoom * 100)}%`;
    },

    applyProfessionalPhotoCrop() {
        const crop = this.professionalPhotoCrop;
        const frame = document.getElementById('modal-prof-photo-crop-frame');
        if (!crop.image || !frame) return;

        const frameSize = frame.clientWidth || 240;
        const baseScale = Math.max(frameSize / crop.image.naturalWidth, frameSize / crop.image.naturalHeight);
        const scale = baseScale * crop.zoom;
        const sourceSize = frameSize / scale;
        const sourceX = crop.image.naturalWidth / 2 - (frameSize / 2 + crop.offsetX) / scale;
        const sourceY = crop.image.naturalHeight / 2 - (frameSize / 2 + crop.offsetY) / scale;
        const canvas = document.createElement('canvas');
        canvas.width = 900;
        canvas.height = 900;
        const context = canvas.getContext('2d');
        context.drawImage(crop.image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);

        const photoUrl = canvas.toDataURL('image/jpeg', 0.88);
        document.getElementById('modal-prof-photo').value = photoUrl;
        this.updateProfessionalPhotoPreview(photoUrl);
        this.closeProfessionalPhotoEditor();
    },

    updateProfessionalPhotoPreview(photoUrl = '') {
        const preview = document.getElementById('modal-prof-photo-preview');
        const clearButton = document.getElementById('modal-prof-photo-clear');
        if (!preview) return;

        const editButton = document.getElementById('modal-prof-photo-edit');

        preview.replaceChildren();
        if (photoUrl) {
            const image = document.createElement('img');
            image.src = photoUrl;
            image.alt = 'Foto do barbeiro';
            preview.appendChild(image);
            clearButton?.classList.remove('hidden');
            editButton?.classList.remove('hidden');
            return;
        }

        const initials = document.getElementById('modal-prof-name')?.value
            ?.split(' ')
            .filter(Boolean)
            .map(part => part[0])
            .join('')
            .slice(0, 2)
            .toUpperCase() || 'BP';
        const fallback = document.createElement('span');
        fallback.innerText = initials;
        preview.appendChild(fallback);
        clearButton?.classList.add('hidden');
        editButton?.classList.add('hidden');
        this.closeProfessionalPhotoEditor();
    },

    setupServicePhotoPicker() {
        const fileInput = document.getElementById('modal-svc-photo-file');
        if (!fileInput || fileInput.dataset.bound === 'true') return;

        fileInput.dataset.bound = 'true';
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                auth.notify('Selecione uma imagem JPG, PNG ou WEBP.', 'error');
                fileInput.value = '';
                return;
            }

            if (file.size > 5 * 1024 * 1024) {
                auth.notify('A imagem precisa ter no maximo 5 MB.', 'error');
                fileInput.value = '';
                return;
            }

            try {
                const photoUrl = await this.prepareProfessionalPhoto(file);
                this.openServicePhotoEditor(photoUrl);
            } catch (err) {
                console.error('Erro ao preparar imagem do servico:', err);
                auth.notify('Nao foi possivel preparar essa imagem.', 'error');
                fileInput.value = '';
            }
        });

        document.getElementById('modal-svc-photo-clear')?.addEventListener('click', () => {
            this.requestPhotoRemoval('service');
        });

        document.getElementById('modal-svc-photo-edit')?.addEventListener('click', () => {
            const photoUrl = document.getElementById('modal-svc-photo')?.value;
            if (photoUrl) this.openServicePhotoEditor(photoUrl);
        });

        document.getElementById('modal-svc-photo-cancel')?.addEventListener('click', () => {
            this.closeServicePhotoEditor();
        });

        document.getElementById('modal-svc-photo-apply')?.addEventListener('click', () => {
            this.applyServicePhotoCrop();
        });

        document.getElementById('modal-svc-photo-zoom')?.addEventListener('input', (event) => {
            this.servicePhotoCrop.zoom = Number(event.target.value) || 1;
            this.renderServicePhotoCrop();
        });

        const cropFrame = document.getElementById('modal-svc-photo-crop-frame');
        cropFrame?.addEventListener('pointerdown', (event) => {
            const crop = this.servicePhotoCrop;
            if (!crop.image) return;
            event.preventDefault();
            crop.dragging = true;
            crop.startX = event.clientX;
            crop.startY = event.clientY;
            crop.startOffsetX = crop.offsetX;
            crop.startOffsetY = crop.offsetY;
            cropFrame.classList.add('is-dragging');
            cropFrame.setPointerCapture?.(event.pointerId);
        });

        cropFrame?.addEventListener('pointermove', (event) => {
            const crop = this.servicePhotoCrop;
            if (!crop.dragging) return;
            crop.offsetX = crop.startOffsetX + event.clientX - crop.startX;
            crop.offsetY = crop.startOffsetY + event.clientY - crop.startY;
            this.renderServicePhotoCrop();
        });

        const stopPhotoDrag = () => {
            this.servicePhotoCrop.dragging = false;
            cropFrame?.classList.remove('is-dragging');
        };
        cropFrame?.addEventListener('pointerup', stopPhotoDrag);
        cropFrame?.addEventListener('pointercancel', stopPhotoDrag);
    },

    openServicePhotoEditor(photoUrl) {
        const editor = document.getElementById('modal-svc-photo-editor');
        const cropImage = document.getElementById('modal-svc-photo-crop-image');
        if (!editor || !cropImage || !photoUrl) return;

        const image = new Image();
        image.onerror = () => auth.notify('Nao foi possivel abrir essa imagem para enquadramento.', 'error');
        image.onload = () => {
            this.servicePhotoCrop = {
                ...this.servicePhotoCrop,
                image,
                sourceUrl: photoUrl,
                zoom: 1,
                offsetX: 0,
                offsetY: 0,
                dragging: false
            };
            cropImage.src = photoUrl;
            editor.classList.remove('hidden');
            const zoomInput = document.getElementById('modal-svc-photo-zoom');
            if (zoomInput) zoomInput.value = '1';
            this.renderServicePhotoCrop();
        };
        image.src = photoUrl;
    },

    closeServicePhotoEditor() {
        document.getElementById('modal-svc-photo-editor')?.classList.add('hidden');
        const cropImage = document.getElementById('modal-svc-photo-crop-image');
        if (cropImage) cropImage.removeAttribute('src');
        this.servicePhotoCrop.image = null;
        this.servicePhotoCrop.dragging = false;
    },

    renderServicePhotoCrop() {
        const crop = this.servicePhotoCrop;
        const frame = document.getElementById('modal-svc-photo-crop-frame');
        const image = document.getElementById('modal-svc-photo-crop-image');
        if (!crop.image || !frame || !image) return;

        const frameSize = frame.clientWidth || 240;
        const baseScale = Math.max(frameSize / crop.image.naturalWidth, frameSize / crop.image.naturalHeight);
        const scale = baseScale * crop.zoom;
        const displayWidth = crop.image.naturalWidth * scale;
        const displayHeight = crop.image.naturalHeight * scale;
        const maxOffsetX = Math.max(0, (displayWidth - frameSize) / 2);
        const maxOffsetY = Math.max(0, (displayHeight - frameSize) / 2);

        crop.offsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, crop.offsetX));
        crop.offsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, crop.offsetY));

        image.style.width = `${displayWidth}px`;
        image.style.height = `${displayHeight}px`;
        image.style.transform = `translate3d(calc(-50% + ${crop.offsetX}px), calc(-50% + ${crop.offsetY}px), 0)`;

        const zoomValue = document.getElementById('modal-svc-photo-zoom-value');
        if (zoomValue) zoomValue.value = `${Math.round(crop.zoom * 100)}%`;
        if (zoomValue) zoomValue.innerText = `${Math.round(crop.zoom * 100)}%`;
    },

    applyServicePhotoCrop() {
        const crop = this.servicePhotoCrop;
        const frame = document.getElementById('modal-svc-photo-crop-frame');
        if (!crop.image || !frame) return;

        const frameSize = frame.clientWidth || 240;
        const baseScale = Math.max(frameSize / crop.image.naturalWidth, frameSize / crop.image.naturalHeight);
        const scale = baseScale * crop.zoom;
        const sourceSize = frameSize / scale;
        const sourceX = crop.image.naturalWidth / 2 - (frameSize / 2 + crop.offsetX) / scale;
        const sourceY = crop.image.naturalHeight / 2 - (frameSize / 2 + crop.offsetY) / scale;
        const canvas = document.createElement('canvas');
        canvas.width = 900;
        canvas.height = 900;
        const context = canvas.getContext('2d');
        context.drawImage(crop.image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);

        const photoUrl = canvas.toDataURL('image/jpeg', 0.88);
        document.getElementById('modal-svc-photo').value = photoUrl;
        this.updateServicePhotoPreview(photoUrl);
        this.closeServicePhotoEditor();
    },

    updateServicePhotoPreview(photoUrl = '') {
        const preview = document.getElementById('modal-svc-photo-preview');
        const clearButton = document.getElementById('modal-svc-photo-clear');
        if (!preview) return;

        const editButton = document.getElementById('modal-svc-photo-edit');
        preview.replaceChildren();
        if (photoUrl) {
            const image = document.createElement('img');
            image.src = photoUrl;
            image.alt = 'Imagem do servico';
            preview.appendChild(image);
            clearButton?.classList.remove('hidden');
            editButton?.classList.remove('hidden');
            return;
        }

        const initials = document.getElementById('modal-svc-name')?.value
            ?.split(' ')
            .filter(Boolean)
            .map(part => part[0])
            .join('')
            .slice(0, 2)
            .toUpperCase() || 'SV';
        const fallback = document.createElement('span');
        fallback.innerText = initials;
        preview.appendChild(fallback);
        clearButton?.classList.add('hidden');
        editButton?.classList.add('hidden');
        this.closeServicePhotoEditor();
    },

    setupInventoryPhotoPicker() {
        const fileInput = document.getElementById('modal-inv-photo-file');
        if (!fileInput || fileInput.dataset.bound === 'true') return;

        fileInput.dataset.bound = 'true';
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                auth.notify('Selecione uma imagem JPG, PNG ou WEBP.', 'error');
                fileInput.value = '';
                return;
            }

            if (file.size > 5 * 1024 * 1024) {
                auth.notify('A imagem precisa ter no maximo 5 MB.', 'error');
                fileInput.value = '';
                return;
            }

            try {
                const photoUrl = await this.prepareProfessionalPhoto(file);
                this.openInventoryPhotoEditor(photoUrl);
            } catch (err) {
                console.error('Erro ao preparar imagem do produto:', err);
                auth.notify('Nao foi possivel preparar essa imagem.', 'error');
                fileInput.value = '';
            }
        });

        document.getElementById('modal-inv-photo-clear')?.addEventListener('click', () => {
            this.requestPhotoRemoval('inventory');
        });

        document.getElementById('modal-inv-photo-edit')?.addEventListener('click', () => {
            const photoUrl = document.getElementById('modal-inv-photo')?.value;
            if (photoUrl) this.openInventoryPhotoEditor(photoUrl);
        });

        document.getElementById('modal-inv-photo-cancel')?.addEventListener('click', () => {
            this.closeInventoryPhotoEditor();
        });

        document.getElementById('modal-inv-photo-apply')?.addEventListener('click', () => {
            this.applyInventoryPhotoCrop();
        });

        document.getElementById('modal-inv-photo-zoom')?.addEventListener('input', (event) => {
            this.inventoryPhotoCrop.zoom = Number(event.target.value) || 1;
            this.renderInventoryPhotoCrop();
        });

        const cropFrame = document.getElementById('modal-inv-photo-crop-frame');
        cropFrame?.addEventListener('pointerdown', (event) => {
            const crop = this.inventoryPhotoCrop;
            if (!crop.image) return;
            event.preventDefault();
            crop.dragging = true;
            crop.startX = event.clientX;
            crop.startY = event.clientY;
            crop.startOffsetX = crop.offsetX;
            crop.startOffsetY = crop.offsetY;
            cropFrame.classList.add('is-dragging');
            cropFrame.setPointerCapture?.(event.pointerId);
        });

        cropFrame?.addEventListener('pointermove', (event) => {
            const crop = this.inventoryPhotoCrop;
            if (!crop.dragging) return;
            crop.offsetX = crop.startOffsetX + event.clientX - crop.startX;
            crop.offsetY = crop.startOffsetY + event.clientY - crop.startY;
            this.renderInventoryPhotoCrop();
        });

        const stopPhotoDrag = () => {
            this.inventoryPhotoCrop.dragging = false;
            cropFrame?.classList.remove('is-dragging');
        };
        cropFrame?.addEventListener('pointerup', stopPhotoDrag);
        cropFrame?.addEventListener('pointercancel', stopPhotoDrag);
    },

    openInventoryPhotoEditor(photoUrl) {
        const editor = document.getElementById('modal-inv-photo-editor');
        const cropImage = document.getElementById('modal-inv-photo-crop-image');
        if (!editor || !cropImage || !photoUrl) return;

        const image = new Image();
        image.onerror = () => auth.notify('Nao foi possivel abrir essa imagem para enquadramento.', 'error');
        image.onload = () => {
            this.inventoryPhotoCrop = {
                ...this.inventoryPhotoCrop,
                image,
                sourceUrl: photoUrl,
                zoom: 1,
                offsetX: 0,
                offsetY: 0,
                dragging: false
            };
            cropImage.src = photoUrl;
            editor.classList.remove('hidden');
            const zoomInput = document.getElementById('modal-inv-photo-zoom');
            if (zoomInput) zoomInput.value = '1';
            this.renderInventoryPhotoCrop();
        };
        image.src = photoUrl;
    },

    closeInventoryPhotoEditor() {
        document.getElementById('modal-inv-photo-editor')?.classList.add('hidden');
        const cropImage = document.getElementById('modal-inv-photo-crop-image');
        if (cropImage) cropImage.removeAttribute('src');
        this.inventoryPhotoCrop.image = null;
        this.inventoryPhotoCrop.dragging = false;
    },

    renderInventoryPhotoCrop() {
        const crop = this.inventoryPhotoCrop;
        const frame = document.getElementById('modal-inv-photo-crop-frame');
        const image = document.getElementById('modal-inv-photo-crop-image');
        if (!crop.image || !frame || !image) return;

        const frameSize = frame.clientWidth || 240;
        const baseScale = Math.max(frameSize / crop.image.naturalWidth, frameSize / crop.image.naturalHeight);
        const scale = baseScale * crop.zoom;
        const displayWidth = crop.image.naturalWidth * scale;
        const displayHeight = crop.image.naturalHeight * scale;
        const maxOffsetX = Math.max(0, (displayWidth - frameSize) / 2);
        const maxOffsetY = Math.max(0, (displayHeight - frameSize) / 2);

        crop.offsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, crop.offsetX));
        crop.offsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, crop.offsetY));

        image.style.width = `${displayWidth}px`;
        image.style.height = `${displayHeight}px`;
        image.style.transform = `translate3d(calc(-50% + ${crop.offsetX}px), calc(-50% + ${crop.offsetY}px), 0)`;

        const zoomValue = document.getElementById('modal-inv-photo-zoom-value');
        if (zoomValue) zoomValue.value = `${Math.round(crop.zoom * 100)}%`;
        if (zoomValue) zoomValue.innerText = `${Math.round(crop.zoom * 100)}%`;
    },

    applyInventoryPhotoCrop() {
        const crop = this.inventoryPhotoCrop;
        const frame = document.getElementById('modal-inv-photo-crop-frame');
        if (!crop.image || !frame) return;

        const frameSize = frame.clientWidth || 240;
        const baseScale = Math.max(frameSize / crop.image.naturalWidth, frameSize / crop.image.naturalHeight);
        const scale = baseScale * crop.zoom;
        const sourceSize = frameSize / scale;
        const sourceX = crop.image.naturalWidth / 2 - (frameSize / 2 + crop.offsetX) / scale;
        const sourceY = crop.image.naturalHeight / 2 - (frameSize / 2 + crop.offsetY) / scale;
        const canvas = document.createElement('canvas');
        canvas.width = 900;
        canvas.height = 900;
        const context = canvas.getContext('2d');
        context.drawImage(crop.image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);

        const photoUrl = canvas.toDataURL('image/jpeg', 0.88);
        document.getElementById('modal-inv-photo').value = photoUrl;
        this.updateInventoryPhotoPreview(photoUrl);
        this.closeInventoryPhotoEditor();
    },

    updateInventoryPhotoPreview(photoUrl = '') {
        const preview = document.getElementById('modal-inv-photo-preview');
        const clearButton = document.getElementById('modal-inv-photo-clear');
        if (!preview) return;

        const editButton = document.getElementById('modal-inv-photo-edit');
        preview.replaceChildren();
        if (photoUrl) {
            const image = document.createElement('img');
            image.src = photoUrl;
            image.alt = 'Imagem do produto';
            preview.appendChild(image);
            clearButton?.classList.remove('hidden');
            editButton?.classList.remove('hidden');
            return;
        }

        const initials = document.getElementById('modal-inv-name')?.value
            ?.split(' ')
            .filter(Boolean)
            .map(part => part[0])
            .join('')
            .slice(0, 2)
            .toUpperCase() || 'PR';
        const fallback = document.createElement('span');
        fallback.innerText = initials;
        preview.appendChild(fallback);
        clearButton?.classList.add('hidden');
        editButton?.classList.add('hidden');
        this.closeInventoryPhotoEditor();
    },

    async editProfessional(id) {
        const prof = this.professionals.find(p => p.id === id);
        if (!prof) return;

        // Fill modal fields
        document.getElementById('modal-prof-name').value = prof.name;
        document.getElementById('modal-prof-phone').value = prof.phone || '';
        document.getElementById('modal-prof-photo').value = prof.photo_url || '';
        document.getElementById('modal-prof-photo-file').value = '';
        this.updateProfessionalPhotoPreview(prof.photo_url || '');
        document.getElementById('modal-prof-commission').value = prof.commission || '';
        document.getElementById('modal-prof-product-commission').value = prof.product_commission || '';
        
        // Open modal (this will also populate the services list via override)
        this.openModal('professional');

        // Check already linked services
        const selectedIds = (prof.services || []).map(s => s.id);
        const checkboxes = document.querySelectorAll('#modal-prof-services-list input');
        checkboxes.forEach(cb => {
            cb.checked = selectedIds.includes(parseInt(cb.value));
        });

        // Update save button to handle update
        const saveBtn = document.getElementById('btn-save-professional');
        if (!saveBtn) return;
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
        const productCommission = document.getElementById('modal-prof-product-commission').value;
        const selectedServices = Array.from(document.querySelectorAll('#modal-prof-services-list input:checked')).map(cb => cb.value);

        if(!name) return alert('Nome é obrigatório');

        try {
            const response = await auth.apiRequest(`/api/professionals/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ name, phone, photoUrl, commission: commission || 0, productCommission: productCommission || 0 })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.success === false) {
                throw new Error(result.message || 'N\u00E3o foi poss\u00EDvel atualizar o barbeiro.');
            }
            
            const servicesResponse = await auth.apiRequest('/api/professional-services', {
                method: 'POST',
                body: JSON.stringify({ profId: id, serviceIds: selectedServices })
            });
            if (!servicesResponse.ok) {
                throw new Error('N\u00E3o foi poss\u00EDvel atualizar os servi\u00E7os do barbeiro.');
            }

            this.closeModal('professional');
            await this.loadProfessionals();
            auth.notify('Barbeiro atualizado com sucesso!', 'success');
        } catch (err) {
            console.error('Erro ao atualizar barbeiro:', err);
            auth.notify(err.message || 'Erro ao atualizar barbeiro.', 'error');
        }
    },

    async deleteProfessional(id, name) {
        const safeName = this.escapeHtml(name);
        this.openDeleteConfirm(
            `Deseja remover o barbeiro <strong>${safeName}</strong> da equipe? Esta ação não pode ser desfeita.`,
            async () => {
                try {
                    const response = await auth.apiRequest(`/api/professionals/${id}`, { method: 'DELETE' });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok || data.success === false) {
                        throw new Error(data.message || 'Não foi possível remover o barbeiro.');
                    }

                    await this.loadProfessionals();
                    this.closeModal('delete-confirm');
                    auth.notify(`Barbeiro "${safeName}" removido com sucesso.`, 'success');
                } catch (err) {
                    console.error('Erro ao remover barbeiro:', err);
                    auth.notify(err.message || 'Erro ao remover barbeiro.', 'error');
                }
            },
            { requiresTyping: true }
        );
    },

    async saveProfessional() {
        const name = document.getElementById('modal-prof-name').value;
        const phone = document.getElementById('modal-prof-phone').value;
        const photoUrl = document.getElementById('modal-prof-photo').value;
        const commission = document.getElementById('modal-prof-commission').value;
        const productCommission = document.getElementById('modal-prof-product-commission').value;
        const selectedServices = Array.from(document.querySelectorAll('#modal-prof-services-list input:checked')).map(cb => cb.value);

        if(!name) return alert('Nome é obrigatório');

        try {
            const res = await auth.apiRequest('/api/professionals', {
                method: 'POST',
                body: JSON.stringify({ barberId: auth.user.id, name, phone, photoUrl, commission: commission || 0, productCommission: productCommission || 0 })
            });
            const prof = await res.json();
            
            // Link services
            await auth.apiRequest('/api/professional-services', {
                method: 'POST',
                body: JSON.stringify({ profId: prof.id, serviceIds: selectedServices })
            });

            this.closeModal('professional');
            this.loadProfessionals();
        } catch (err) { alert('Erro ao salvar barbeiro'); }
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

    async loadBookingSettings() {
        const feedback = document.getElementById('booking-settings-feedback');
        try {
            const response = await auth.apiRequest(`/api/business-settings/${auth.user.id}`);
            const data = await response.json();
            if (!response.ok || data.success === false) throw new Error(data.message || 'Não foi possível carregar as configurações.');
            this.bookingSettings = data.settings || this.getDefaultBookingSettings();
        } catch (err) {
            console.error('Erro ao carregar configurações de agendamento:', err);
            this.bookingSettings = this.getDefaultBookingSettings();
            if (feedback) {
                feedback.className = 'settings-feedback is-error';
                feedback.innerText = err.message || 'Não foi possível carregar as configurações.';
            }
        }

        this.renderBookingSettings();
    },

    renderBookingSettings() {
        const settings = this.bookingSettings || this.getDefaultBookingSettings();
        const styleInput = document.querySelector(`input[name="booking-style"][value="${settings.bookingStyle}"]`)
            || document.querySelector('input[name="booking-style"]');
        if (styleInput) styleInput.checked = true;

        const interval = document.getElementById('booking-interval');
        const breakEnabled = document.getElementById('booking-break-enabled');
        const breakStart = document.getElementById('booking-break-start');
        const breakEnd = document.getElementById('booking-break-end');
        const allowCustom = document.getElementById('booking-allow-custom-time');
        if (interval) interval.value = String(settings.intervalMinutes || 60);
        if (breakEnabled) breakEnabled.checked = settings.breakEnabled !== false;
        if (breakStart) breakStart.value = settings.breakStart || '12:00';
        if (breakEnd) breakEnd.value = settings.breakEnd || '14:00';
        if (allowCustom) allowCustom.checked = settings.allowCustomTime !== false;
        this.bookingBlocks = [
            ...(settings.blockedDates || []).map(date => ({ date, start: '', end: '', reason: 'Dia bloqueado' })),
            ...(settings.blockedTimes || [])
        ];
        this.renderBookingBlocks();

        document.querySelectorAll('.booking-schedule-row').forEach(row => {
            const daySettings = settings.weeklySchedule?.[row.dataset.day] || { enabled: true, start: '09:00', end: '18:00' };
            const enabled = row.querySelector('[data-schedule-field="enabled"]');
            const start = row.querySelector('[data-schedule-field="start"]');
            const end = row.querySelector('[data-schedule-field="end"]');
            if (enabled) enabled.checked = daySettings.enabled !== false;
            if (start) start.value = daySettings.start || '09:00';
            if (end) end.value = daySettings.end || '18:00';
            row.classList.toggle('is-closed', enabled && !enabled.checked);
        });

        if (breakEnabled) {
            breakEnabled.onchange = () => document.getElementById('booking-break-fields')?.classList.toggle('is-disabled', !breakEnabled.checked);
            breakEnabled.onchange();
        }
        document.querySelectorAll('.booking-schedule-row [data-schedule-field="enabled"]').forEach(input => {
            input.onchange = () => input.closest('.booking-schedule-row')?.classList.toggle('is-closed', !input.checked);
        });
    },

    collectBookingSettings() {
        const weeklySchedule = {};
        document.querySelectorAll('.booking-schedule-row').forEach(row => {
            weeklySchedule[row.dataset.day] = {
                enabled: Boolean(row.querySelector('[data-schedule-field="enabled"]')?.checked),
                start: row.querySelector('[data-schedule-field="start"]')?.value || '09:00',
                end: row.querySelector('[data-schedule-field="end"]')?.value || '18:00'
            };
        });

        return {
            bookingStyle: document.querySelector('input[name="booking-style"]:checked')?.value || 'classic',
            intervalMinutes: Number(document.getElementById('booking-interval')?.value || 60),
            breakEnabled: Boolean(document.getElementById('booking-break-enabled')?.checked),
            breakStart: document.getElementById('booking-break-start')?.value || '12:00',
            breakEnd: document.getElementById('booking-break-end')?.value || '14:00',
            allowCustomTime: Boolean(document.getElementById('booking-allow-custom-time')?.checked),
            blockedDates: (this.bookingBlocks || []).filter(block => !block.start && !block.end).map(block => block.date),
            blockedTimes: (this.bookingBlocks || []).filter(block => block.start && block.end),
            weeklySchedule
        };
    },

    renderBookingBlocks() {
        const container = document.getElementById('booking-blocks-list');
        if (!container) return;
        const blocks = this.bookingBlocks || [];
        container.innerHTML = blocks.length
            ? blocks.map((block, index) => `<div class="booking-block-item"><span><strong>${this.escapeHtml(block.date)}</strong>${block.start ? ` · ${block.start}–${block.end}` : ' · Dia inteiro'}<small>${this.escapeHtml(block.reason || 'Bloqueio')}</small></span><button type="button" class="btn-queue-cancel" onclick="admin.removeBookingBlock(${index})" aria-label="Remover bloqueio">×</button></div>`).join('')
            : '<span class="dashboard-empty-note">Nenhum bloqueio cadastrado.</span>';
    },

    addBookingBlock() {
        const date = document.getElementById('booking-block-date')?.value;
        const start = document.getElementById('booking-block-start')?.value || '';
        const end = document.getElementById('booking-block-end')?.value || '';
        const reason = document.getElementById('booking-block-reason')?.value.trim() || 'Bloqueio';
        if (!date) return auth.notify('Informe a data do bloqueio.', 'error');
        if ((start && !end) || (!start && end) || (start && end && start >= end)) return auth.notify('Confira o intervalo do bloqueio.', 'error');
        this.bookingBlocks = this.bookingBlocks || [];
        this.bookingBlocks.push({ date, start, end, reason });
        ['booking-block-date', 'booking-block-start', 'booking-block-end', 'booking-block-reason'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        this.renderBookingBlocks();
    },

    removeBookingBlock(index) {
        this.bookingBlocks = (this.bookingBlocks || []).filter((_, blockIndex) => blockIndex !== index);
        this.renderBookingBlocks();
    },

    async saveBookingSettings() {
        const button = document.getElementById('save-booking-settings-btn');
        const feedback = document.getElementById('booking-settings-feedback');
        const settings = this.collectBookingSettings();
        const enabledDays = Object.values(settings.weeklySchedule).filter(day => day.enabled);
        const hasInvalidDay = enabledDays.some(day => !day.start || !day.end || day.start >= day.end);
        const hasInvalidBreak = settings.breakEnabled && (!settings.breakStart || !settings.breakEnd || settings.breakStart >= settings.breakEnd);

        if (!enabledDays.length) {
            if (feedback) {
                feedback.className = 'settings-feedback is-error';
                feedback.innerText = 'Ative pelo menos um dia de atendimento.';
            }
            return;
        }
        if (hasInvalidDay || hasInvalidBreak) {
            if (feedback) {
                feedback.className = 'settings-feedback is-error';
                feedback.innerText = 'Confira os horários de abertura, fechamento e intervalo.';
            }
            return;
        }

        if (button) {
            button.disabled = true;
            button.innerText = 'Salvando...';
        }
        if (feedback) {
            feedback.className = 'settings-feedback';
            feedback.innerText = 'Salvando configurações...';
        }

        try {
            const response = await auth.apiRequest(`/api/business-settings/${auth.user.id}`, {
                method: 'PATCH',
                body: JSON.stringify(settings)
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) throw new Error(data.message || 'Não foi possível salvar as configurações.');
            this.bookingSettings = data.settings || settings;
            if (feedback) {
                feedback.className = 'settings-feedback';
                feedback.innerText = '';
            }
            auth.notify('Ajustes da reserva atualizados.', 'success');
        } catch (err) {
            console.error('Erro ao salvar configurações de agendamento:', err);
            if (feedback) {
                feedback.className = 'settings-feedback is-error';
                feedback.innerText = err.message || 'Não foi possível salvar as configurações.';
            }
            auth.notify(err.message || 'Não foi possível salvar as configurações.', 'error');
        } finally {
            if (button) {
                button.disabled = false;
                button.innerText = 'Salvar ajustes';
            }
        }
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
        if (this.services.length === 0) {
            container.innerHTML = `
                <tr class="empty-row">
                    <td colspan="5">
                        <div class="empty-state empty-state-services">
                            <div class="empty-state-icon">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                                    stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
                                </svg>
                            </div>
                            <div>
                                <strong>Nenhum servi&ccedil;o cadastrado</strong>
                                <span>Cadastre os servi&ccedil;os da barbearia para liberar agendamentos e acompanhar faturamento por atendimento.</span>
                            </div>
                            <button class="btn btn-primary btn-sm" onclick="admin.openModal('service')">Novo Servi&ccedil;o</button>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }
        container.innerHTML = this.services.map(s => {
            const photoUrl = s.photo_url ? this.escapeHtml(s.photo_url) : '';
            const photoAlt = this.escapeHtml(`Imagem de ${s.name}`);
            const serviceName = this.escapeHtml(s.name);

            return `
            <tr class="service-row">
                <td>
                    <div class="service-photo-cell">
                        <span class="service-initial${photoUrl ? ' has-photo' : ''}">
                            ${photoUrl ? `<img src="${photoUrl}" alt="${photoAlt}">` : this.escapeHtml(s.name.charAt(0).toUpperCase())}
                        </span>
                    </div>
                </td>
                <td>
                    <div class="service-name-text">
                        <strong>${serviceName}</strong>
                        <small>${s.is_package ? `Pacote · ${Number(s.package_sessions || 0)} atendimentos` : 'Serviço ativo'}</small>
                    </div>
                </td>
                <td><span class="service-chip">${s.duration || '-'}</span></td>
                <td><span class="service-price">R$ ${parseFloat(s.price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span></td>
                <td>
                    <div class="service-actions">
                        <button class="btn btn-ghost btn-sm" onclick="admin.editService(${s.id})">Editar</button>
                        <button class="btn-queue-cancel" aria-label="Excluir serviço" onclick="admin.deleteService(${s.id}, '${s.name.replace(/'/g, "\\'")}')">×</button>
                    </div>
                </td>
            </tr>
        `;
        }).join('');
    },

    async editService(id) {
        const svc = this.services.find(s => s.id === id);
        if (!svc) return;

        this.editingServiceId = id;
        document.getElementById('modal-svc-name').value = svc.name;
        document.getElementById('modal-svc-photo').value = svc.photo_url || '';
        document.getElementById('modal-svc-photo-file').value = '';
        this.updateServicePhotoPreview(svc.photo_url || '');
        document.getElementById('modal-svc-price').value = svc.price;
        const packageCheckbox = document.getElementById('modal-svc-is-package');
        const packageSessions = document.getElementById('modal-svc-package-sessions');
        if (packageCheckbox) packageCheckbox.checked = Boolean(svc.is_package);
        if (packageSessions) {
            packageSessions.value = svc.package_sessions || '';
            packageSessions.disabled = !svc.is_package;
        }
        const durationMatch = String(svc.duration || '').match(/(\d+(?:[.,]\d+)?)\s*(hora|horas|h|minuto|minutos|min|m)?/i);
        document.getElementById('modal-svc-duration-value').value = durationMatch ? durationMatch[1].replace(',', '.') : '';
        document.getElementById('modal-svc-duration-unit').value = durationMatch?.[2]?.toLowerCase().startsWith('h') ? 'horas' : 'minutos';

        const saveBtn = document.querySelector('#modal-service .btn-full');
        if (saveBtn) saveBtn.innerText = 'Salvar Alterações';
        this.openModal('service');
    },

    async deleteService(id, name) {
        const safeName = this.escapeHtml(name);
        this.openDeleteConfirm(`Deseja excluir o servi&ccedil;o <strong>${safeName}</strong>? Ele ser&aacute; removido da tabela de servi&ccedil;os e dos v&iacute;nculos com barbeiros.`, async () => {
            try {
                const response = await auth.apiRequest(`/api/services/${id}`, { method: 'DELETE' });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || result.success === false) {
                    throw new Error(result.message || 'Não foi possível excluir o serviço.');
                }

                await this.loadServices();
                await this.loadProfessionals();
                this.closeModal('delete-confirm');
                auth.notify(`Serviço "${name}" excluído com sucesso.`, 'success');
            } catch (err) {
                console.error('Erro ao excluir serviço:', err);
                auth.notify(err.message || 'Não foi possível excluir o serviço.', 'error');
            }
        }, { requiresTyping: true });
    },

    async saveService() {
        const name = document.getElementById('modal-svc-name').value;
        const photoUrl = document.getElementById('modal-svc-photo').value;
        const price = document.getElementById('modal-svc-price').value;
        const isPackage = Boolean(document.getElementById('modal-svc-is-package')?.checked);
        const packageSessions = Number(document.getElementById('modal-svc-package-sessions')?.value || 0);
        const durationValue = document.getElementById('modal-svc-duration-value').value;
        const durationUnit = document.getElementById('modal-svc-duration-unit').value;
        const durationNumber = Number(durationValue);

        if(!name || !price || !durationNumber || durationNumber <= 0) return alert('Nome, preço e duração são obrigatórios');
        if (isPackage && packageSessions < 2) return alert('Informe pelo menos 2 atendimentos para o pacote');
        const duration = `${durationNumber} ${durationUnit}`;

        try {
            const isEditing = Boolean(this.editingServiceId);
            const method = isEditing ? 'PATCH' : 'POST';
            const url = this.editingServiceId ? `/api/services/${this.editingServiceId}` : '/api/services';
            
            const response = await auth.apiRequest(url, {
                method,
                body: JSON.stringify({ barberId: auth.user.id, name, price, duration, photoUrl, isPackage, packageSessions })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.success === false) {
                throw new Error(result.message || 'Nao foi possivel salvar o servico.');
            }

            this.closeModal('service');
            await this.loadServices();
            auth.notify(`Serviço ${isEditing ? 'atualizado' : 'cadastrado'} com sucesso.`, 'success');
        } catch (err) {
            console.error('Erro ao salvar serviço:', err);
            auth.notify(err.message || 'Não foi possível salvar o serviço.', 'error');
        }
    },



    modalStack: [],

    openModal(type) {
        if (type === 'professional') {
            const list = document.getElementById('modal-prof-services-list');
            if (list) list.innerHTML = this.services.map(s => `
                <label class="checkbox-item">
                    <input type="checkbox" value="${s.id}">
                    <span>${s.name}</span>
                </label>
            `).join('');
        }
        const modalId = `modal-${type}`;
        if (!this.modalStack.includes(modalId)) {
            this.modalStack.push(modalId);
        }
        const modalElement = document.getElementById(modalId);
        if (!modalElement) {
            this.modalStack = this.modalStack.filter(id => id !== modalId);
            console.error(`Modal id="${modalId}" não encontrado.`);
            return;
        }
        modalElement.style.zIndex = String(2000 + (this.modalStack.length - 1) * 20);
        modalElement.classList.remove('hidden');
        const modalContent = modalElement.querySelector('.modal-content');
        if (modalContent) {
            modalContent.scrollTop = 0;
            modalContent.scrollLeft = 0;
        }
        document.body.classList.add('modal-open');
    },

    closeModal(type) {
        const modalId = `modal-${type}`;
        if (type === 'professional') {
            const saveBtn = document.getElementById('btn-save-professional');
            if (saveBtn) {
                saveBtn.innerText = 'Cadastrar Barbeiro';
                saveBtn.onclick = () => this.saveProfessional();
            }
            
            // Clear fields
            const pName = document.getElementById('modal-prof-name');
            if (pName) {
                pName.value = '';
                document.getElementById('modal-prof-phone').value = '';
                document.getElementById('modal-prof-photo').value = '';
                document.getElementById('modal-prof-photo-file').value = '';
                this.updateProfessionalPhotoPreview('');
                document.getElementById('modal-prof-commission').value = '';
                document.getElementById('modal-prof-product-commission').value = '';
            }
        }
        if (type === 'client') {
            const cName = document.getElementById('modal-client-name');
            if (cName) {
                cName.value = '';
                document.getElementById('modal-client-phone').value = '';
                document.getElementById('modal-client-notes').value = '';
                document.getElementById('modal-client-birthday').value = '';
                document.getElementById('modal-client-referral').value = '';
            }
        }
        if (type === 'service') {
            this.editingServiceId = null;
            const saveBtn = document.querySelector('#modal-service .btn-full');
            if (saveBtn) saveBtn.innerText = 'Adicionar Serviço';
            
            const sName = document.getElementById('modal-svc-name');
            if (sName) {
                sName.value = '';
                document.getElementById('modal-svc-photo').value = '';
                document.getElementById('modal-svc-photo-file').value = '';
                this.updateServicePhotoPreview('');
                document.getElementById('modal-svc-price').value = '';
                const packageCheckbox = document.getElementById('modal-svc-is-package');
                const packageSessions = document.getElementById('modal-svc-package-sessions');
                if (packageCheckbox) {
                    packageCheckbox.checked = false;
                    packageCheckbox.onchange = () => {
                        if (packageSessions) packageSessions.disabled = !packageCheckbox.checked;
                    };
                }
                if (packageSessions) {
                    packageSessions.value = '';
                    packageSessions.disabled = true;
                }
                document.getElementById('modal-svc-duration-value').value = '';
                document.getElementById('modal-svc-duration-unit').value = 'minutos';
            }
        }
        if (type === 'inventory') {
            const modal = document.getElementById('modal-inventory');
            modal?.querySelector('.modal-title')?.replaceChildren('Novo Produto');
            modal?.querySelector('.btn-full')?.replaceChildren('Salvar no Estoque');

            document.getElementById('modal-inv-edit-id').value = '';
            document.getElementById('modal-inv-name').value = '';
            document.getElementById('modal-inv-desc').value = '';
            document.getElementById('modal-inv-supplier').value = '';
            document.getElementById('modal-inv-cost').value = '';
            document.getElementById('modal-inv-photo').value = '';
            document.getElementById('modal-inv-photo-file').value = '';
            this.updateInventoryPhotoPreview('');
            document.getElementById('modal-inv-qty').value = '';
            document.getElementById('modal-inv-unit').value = '';
            document.getElementById('modal-inv-price').value = '';
            document.getElementById('modal-inv-min').value = '';
            const commissionCheckbox = document.getElementById('modal-inv-generate-commission');
            if (commissionCheckbox) commissionCheckbox.checked = true;
        }

        this.modalStack = this.modalStack.filter(id => id !== modalId);
        const modalElement = document.getElementById(modalId);
        if (!modalElement) {
            if (this.modalStack.length === 0) document.body.classList.remove('modal-open');
            return;
        }
        modalElement.classList.add('hidden');
        modalElement.style.zIndex = '';
        
        if (this.modalStack.length === 0) {
            document.body.classList.remove('modal-open');
        }
    }
};

const agenda = {
    calendar: null,
    allAppointments: [],
    sourceAppointments: [],

    init() {
        const calendarEl = document.getElementById('calendar');
        if (!calendarEl || this.calendar) return;

        this.calendar = new FullCalendar.Calendar(calendarEl, {
            initialView: 'timeGridWeek',
            headerToolbar: {
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,timeGridDay'
            },
            buttonText: {
                today: 'Hoje',
                month: 'Mês',
                week: 'Semana',
                day: 'Dia'
            },
            eventDisplay: 'block',
            dayMaxEvents: 3,
            navLinks: true,
            navLinkDayClick: (date) => {
                this.calendar.changeView('timeGridWeek', date);
            },
            dayCellDidMount: (info) => {
                const dateStr = [info.date.getFullYear(), String(info.date.getMonth() + 1).padStart(2, '0'), String(info.date.getDate()).padStart(2, '0')].join('-');
                const count = this.allAppointments.filter(a => {
                    const aDate = String(a.appointment_date || '').slice(0, 10);
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
                            this.calendar.changeView('timeGridDay', info.date);
                        };
                        info.el.querySelector('.fc-daygrid-day-top').appendChild(kpi);
                    }
                }
            },
            slotEventOverlap: false,
            eventMaxStack: 3,
            locale: 'pt-br',
            firstDay: 1,
            nowIndicator: true,
            expandRows: true,
            scrollTime: '08:00:00',
            slotDuration: '00:30:00',
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
                this.showAppointmentDetails(info.event);
            }
        });

        this.calendar.render();
        this.populateProfessionalFilter();
        admin.loadData();
    },

    populateProfessionalFilter() {
        const select = document.getElementById('agenda-professional-filter');
        if (!select) return;
        
        const professionals = admin.professionals || [];
        select.innerHTML = '<option value="all">Todos os Barbeiros</option>' +
            professionals.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    },

    filterByProfessional(profId) {
        const apts = this.sourceAppointments || admin.allAppointments || [];
        if (profId === 'all') {
            this.renderEvents(apts);
        } else {
            const filtered = apts.filter(a => String(a.professional_id) === String(profId));
            this.renderEvents(filtered, true);
        }
    },

    showAppointmentDetails(event) {
        const name = event.title;
        const service = event.extendedProps.service;
        const professional = event.extendedProps.professional || 'Geral';
        const duration = event.extendedProps.duration;
        const status = event.extendedProps.status;
        const timeOptions = { hour: '2-digit', minute: '2-digit' };
        const time = event.start.toLocaleTimeString('pt-BR', timeOptions);
        const end = event.end || new Date(event.start.getTime() + this.durationToMinutes(duration) * 60000);
        const endTime = end.toLocaleTimeString('pt-BR', timeOptions);

        document.getElementById('view-app-name').innerText = name;
        document.getElementById('view-app-professional').innerText = professional;
        document.getElementById('view-app-service').innerText = `${service} · ${this.formatDuration(duration)}`;
        document.getElementById('view-app-time').innerText = time;
        document.getElementById('view-app-end-time').innerText = endTime;
        
        const statusEl = document.getElementById('view-app-status');
        const statusLabels = { pending: 'Agendado', confirmed: 'Confirmado', arrived: 'Cliente chegou', in_progress: 'Em atendimento', completed: 'Concluído', no_show: 'Faltou', canceled: 'Cancelado' };
        statusEl.innerText = statusLabels[status] || status;
        statusEl.className = `status-badge ${['completed', 'confirmed', 'arrived', 'in_progress'].includes(status) ? 'status-ok' : (['pending'].includes(status) ? 'status-warn' : 'status-danger')}`;

        const actions = document.getElementById('appointment-modal-actions');
        const activeStatus = ['pending', 'confirmed', 'arrived', 'in_progress'].includes(status);
        actions?.classList.toggle('hidden', !activeStatus);
        if (activeStatus) {
            document.getElementById('btn-view-edit').onclick = () => this.openEditAppointment(event);
            document.getElementById('btn-view-confirm').onclick = () => admin.setAppointmentStatus(event.id, 'confirmed');
            document.getElementById('btn-view-arrived').onclick = () => admin.setAppointmentStatus(event.id, 'arrived');
            document.getElementById('btn-view-start').onclick = () => admin.setAppointmentStatus(event.id, 'in_progress');
            document.getElementById('btn-view-no-show').onclick = () => admin.setAppointmentStatus(event.id, 'no_show');
            document.getElementById('btn-view-complete').onclick = () => admin.completeService(event.id, name);
            document.getElementById('btn-view-cancel').onclick = () => admin.cancelService(event.id, name);
            document.getElementById('btn-view-confirm').classList.toggle('hidden', status !== 'pending');
            document.getElementById('btn-view-arrived').classList.toggle('hidden', !['pending', 'confirmed'].includes(status));
            document.getElementById('btn-view-start').classList.toggle('hidden', !['arrived'].includes(status));
            document.getElementById('btn-view-no-show').classList.toggle('hidden', !['pending', 'confirmed', 'arrived'].includes(status));
        }

        admin.openModal('view-appointment');
    },

    openEditAppointment(event) {
        const appointment = event.extendedProps.appointment || {};
        const serviceSelect = document.getElementById('edit-appointment-service');
        const professionalSelect = document.getElementById('edit-appointment-professional');
        serviceSelect.innerHTML = (admin.services || []).map(service =>
            `<option value="${service.id}">${service.name} · ${this.formatDuration(service.duration)}</option>`
        ).join('');
        professionalSelect.innerHTML = (admin.professionals || []).map(professional =>
            `<option value="${professional.id}">${professional.name}</option>`
        ).join('');

        document.getElementById('edit-appointment-id').value = event.id;
        document.getElementById('edit-appointment-client').value = appointment.clientName || event.title || '';
        document.getElementById('edit-appointment-phone').value = appointment.clientPhone || '';
        document.getElementById('edit-appointment-date').value = appointment.date || '';
        document.getElementById('edit-appointment-time').value = appointment.time || '';
        serviceSelect.value = String(appointment.serviceId || '');
        professionalSelect.value = String(appointment.professionalId || '');

        admin.openModal('edit-appointment');
    },

    async saveEditedAppointment() {
        const id = document.getElementById('edit-appointment-id').value;
        const clientName = document.getElementById('edit-appointment-client').value.trim();
        const clientPhone = document.getElementById('edit-appointment-phone').value.trim();
        const serviceId = document.getElementById('edit-appointment-service').value;
        const professionalId = document.getElementById('edit-appointment-professional').value;
        const date = document.getElementById('edit-appointment-date').value;
        const time = document.getElementById('edit-appointment-time').value;

        if (!id || !clientName || !clientPhone || !serviceId || !professionalId || !date || !time) {
            return auth.notify('Preencha todos os dados do agendamento.', 'error');
        }

        try {
            const res = await auth.apiRequest(`/api/appointments/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ clientName, clientPhone, serviceId, professionalId, date, time })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) {
                throw new Error(data.message || 'Não foi possível atualizar o agendamento.');
            }

            admin.closeModal('edit-appointment');
            admin.closeModal('view-appointment');
            await admin.loadData();
            auth.notify('Agendamento atualizado com sucesso!', 'success');
        } catch (err) {
            console.error('Erro ao editar agendamento:', err);
            auth.notify(err.message || 'Erro ao editar agendamento.', 'error');
        }
    },

    durationToMinutes(value) {
        const text = String(value ?? '').trim().toLowerCase().replace(',', '.');
        const match = text.match(/(\d+(?:\.\d+)?)\s*(hora|horas|h|minuto|minutos|min|m)?/i);
        if (!match) return 30;
        const amount = Number(match[1]);
        if (!Number.isFinite(amount) || amount <= 0) return 30;
        return /^h/i.test(match[2] || '') ? Math.round(amount * 60) : Math.round(amount);
    },

    formatDuration(value) {
        const minutes = this.durationToMinutes(value);
        if (minutes >= 60) {
            const hours = Math.floor(minutes / 60);
            const remaining = minutes % 60;
            return remaining ? `${hours}h ${remaining}min` : `${hours}h`;
        }
        return `${minutes} min`;
    },

    toCalendarDateTime(date, time) {
        const pad = number => String(number).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
    },

    renderEvents(appointments, preserveSource = false) {
        if (!this.calendar) return;
        if (!preserveSource) this.sourceAppointments = appointments;
        this.allAppointments = appointments;

        const today = typeof admin !== 'undefined' && typeof admin.currentDateValue === 'function' ? admin.currentDateValue() : (() => {
            const now = new Date();
            return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        })();
        const countToday = appointments.filter(a => String(a.appointment_date).slice(0, 10) === today && a.status !== 'canceled').length;
        const countPending = appointments.filter(a => ['pending', 'confirmed', 'arrived', 'in_progress'].includes(a.status)).length;
        const countCompleted = appointments.filter(a => a.status === 'completed').length;
        document.getElementById('agenda-today-count')?.replaceChildren(String(countToday));
        document.getElementById('agenda-pending-count')?.replaceChildren(String(countPending));
        document.getElementById('agenda-completed-count')?.replaceChildren(String(countCompleted));

        const events = appointments.map(a => {
            let dateStr = String(a.appointment_date || '').slice(0, 10);
            if (!dateStr) {
                const now = new Date();
                dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            }

            const [year, month, day] = dateStr.split('-').map(Number);
            const [hour, minute] = String(a.appointment_time || '00:00').slice(0, 5).split(':').map(Number);
            const startDate = new Date(year, month - 1, day, hour || 0, minute || 0);
            const endDate = new Date(startDate.getTime() + this.durationToMinutes(a.service_duration) * 60000);

            return {
                id: a.id,
                title: a.client_name,
                start: this.toCalendarDateTime(startDate),
                end: this.toCalendarDateTime(endDate),
                backgroundColor: a.status === 'completed'
                    ? 'rgba(26, 167, 143, 0.14)'
                    : (a.status === 'canceled' || a.status === 'no_show' ? 'rgba(217, 77, 91, 0.14)' : 'rgba(26, 167, 143, 0.14)'),
                borderColor: a.status === 'completed' ? 'var(--success)' : (a.status === 'canceled' || a.status === 'no_show' ? 'var(--danger)' : 'var(--primary)'),
                textColor: a.status === 'completed' ? '#117b69' : (a.status === 'canceled' || a.status === 'no_show' ? '#b83c48' : 'var(--text-main)'),
                classNames: [`event-${a.status}`],
                extendedProps: {
                    service: a.service_name,
                    professional: a.professional_name || 'Geral',
                    status: a.status,
                    duration: a.service_duration,
                    appointment: {
                        clientName: a.client_name,
                        clientPhone: a.client_phone,
                        serviceId: a.service_id,
                        professionalId: a.professional_id,
                        date: dateStr,
                        time: String(a.appointment_time || '').slice(0, 5)
                    }
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
            console.warn('Sessão expirada por inatividade (Gestano).');
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
    navGroupStorageKey() {
        const userKey = auth.user?.id || auth.user?.email || 'guest';
        return `barberpoint_sidebar_groups_${String(userKey).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    },

    setNavGroupState(group, isExpanded, heading, persist = true) {
        const title = heading || document.querySelector(`.nav-group-title[data-group="${group}"]`);
        if (!title) return;

        title.setAttribute('aria-expanded', String(isExpanded));
        title.classList.toggle('is-collapsed', !isExpanded);
        document.querySelectorAll(`[data-sidebar-group="${group}"]`).forEach(item => {
            item.classList.toggle('nav-group-item-collapsed', !isExpanded);
        });

        if (persist) {
            let saved = {};
            try { saved = JSON.parse(authStorage.read(this.navGroupStorageKey()) || '{}'); } catch (_) { /* Ignore invalid state. */ }
            saved[group] = isExpanded;
            authStorage.write(this.navGroupStorageKey(), JSON.stringify(saved));
        }
    },

    toggleNavGroup(group, heading) {
        const isExpanded = heading?.getAttribute('aria-expanded') !== 'false';
        this.setNavGroupState(group, !isExpanded, heading);
    },

    initNavGroups() {
        // A reload starts with a clean navigation context. The expanded state is
        // intentionally not restored between page loads.
        authStorage.remove(this.navGroupStorageKey());
        document.querySelectorAll('.nav-group-title[data-group]').forEach(heading => {
            const group = heading.dataset.group;
            this.setNavGroupState(group, false, heading, false);
        });
    },

    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        if (window.innerWidth <= 1024) {
            const isOpen = sidebar.classList.toggle('open');
            document.querySelector('.sidebar-scrim')?.classList.toggle('open', isOpen);
            return;
        }

        sidebar.classList.toggle('collapsed');
        
        // Save state
        localStorage.setItem('sidebar_collapsed', sidebar.classList.contains('collapsed'));
    },

    init() {
        const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
        if (isCollapsed) {
            document.getElementById('sidebar').classList.add('collapsed');
        }
        this.initNavGroups();
    }
};

window.onload = () => {
    auth.init();
    ui.init();
};
// Global Modal Interactions
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (admin.modalStack && admin.modalStack.length > 0) {
            const topModalId = admin.modalStack[admin.modalStack.length - 1];
            const type = topModalId.replace('modal-', '');
            admin.closeModal(type);
        } else {
            const openModal = document.querySelector('.modal-overlay:not(.hidden)');
            if (openModal) {
                const type = openModal.id.replace('modal-', '');
                admin.closeModal(type);
            }
        }
    }
});

document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.appointment-actions')) {
        admin.closeAppointmentMenus();
    }
    if (e.target.classList.contains('modal-overlay')) {
        const type = e.target.id.replace('modal-', '');
        admin.closeModal(type);
    }
});

// Global Error Handler for debugging production issues
window.onerror = function(msg, url, line, col, error) {
    const errorMsg = `[JS ERROR] ${msg} em ${url}:${line}:${col}`;
    console.error(errorMsg, error);
    // Only alert for Gestano scripts to avoid noise from extensions
    if (url.includes('admin.js') || url.includes('admin.html')) {
        alert(errorMsg);
    }
    return false;
};

// Extra safety: expose admin globally
window.admin = admin;
console.log('[Gestano] admin.js fully initialized');
