require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'BarberPoint_fallback_secret';
const ADMIN_EMAIL = 'brasil.hyuri@gmail.com';
const DEFAULT_MONTHLY_GOAL = 0;
const PERMISSION_KEYS = ['dashboard', 'agenda', 'billing', 'clientes', 'vendas', 'estoque', 'barbeiros', 'comissoes', 'servicos', 'configuracoes'];
const DEFAULT_PERMISSIONS = Object.fromEntries(PERMISSION_KEYS.map(key => [key, true]));

const BOOKING_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const BOOKING_DAYS = [0, 1, 2, 3, 4, 5, 6];

const createDefaultBookingSettings = () => ({
    bookingStyle: 'classic',
    intervalMinutes: 60,
    breakEnabled: true,
    breakStart: '12:00',
    breakEnd: '14:00',
    allowCustomTime: true,
    weeklySchedule: Object.fromEntries(BOOKING_DAYS.map(day => [String(day), {
        enabled: true,
        start: '09:00',
        end: '18:00'
    }]))
});

const normalizeBookingSettings = (source = {}) => {
    const defaults = createDefaultBookingSettings();
    const rawSchedule = source.weeklySchedule && typeof source.weeklySchedule === 'object'
        ? source.weeklySchedule
        : {};
    const validStyles = ['classic', 'gold', 'minimal', 'red', 'graphite', 'ocean'];
    const interval = Number(source.intervalMinutes);
    const breakStart = BOOKING_TIME_PATTERN.test(String(source.breakStart || ''))
        ? String(source.breakStart)
        : defaults.breakStart;
    const breakEnd = BOOKING_TIME_PATTERN.test(String(source.breakEnd || ''))
        ? String(source.breakEnd)
        : defaults.breakEnd;

    const weeklySchedule = Object.fromEntries(BOOKING_DAYS.map(day => {
        const fallback = defaults.weeklySchedule[String(day)];
        const config = rawSchedule[String(day)] || rawSchedule[day] || {};
        const start = BOOKING_TIME_PATTERN.test(String(config.start || '')) ? String(config.start) : fallback.start;
        const end = BOOKING_TIME_PATTERN.test(String(config.end || '')) ? String(config.end) : fallback.end;
        return [String(day), {
            enabled: config.enabled !== false,
            start,
            end
        }];
    }));

    return {
        bookingStyle: validStyles.includes(source.bookingStyle) ? source.bookingStyle : defaults.bookingStyle,
        intervalMinutes: [15, 30, 60].includes(interval) ? interval : defaults.intervalMinutes,
        breakEnabled: source.breakEnabled !== false,
        breakStart,
        breakEnd,
        allowCustomTime: source.allowCustomTime !== false,
        weeklySchedule
    };
};

const timeToMinutes = value => {
    const [hours, minutes] = String(value || '').split(':').map(Number);
    return (hours * 60) + minutes;
};

const getAvailableBookingTimes = (settings, dateValue) => {
    const normalized = normalizeBookingSettings(settings);
    const parts = String(dateValue || '').slice(0, 10).split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return [];

    const day = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
    const dayConfig = normalized.weeklySchedule[String(day)];
    if (!dayConfig?.enabled) return [];

    const start = timeToMinutes(dayConfig.start);
    const end = timeToMinutes(dayConfig.end);
    const breakStart = timeToMinutes(normalized.breakStart);
    const breakEnd = timeToMinutes(normalized.breakEnd);
    const times = [];

    for (let minutes = start; minutes <= end; minutes += normalized.intervalMinutes) {
        if (normalized.breakEnabled && breakStart < breakEnd && minutes >= breakStart && minutes < breakEnd) continue;
        times.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
    }

    return times;
};

const readBookingSettingsRow = row => {
    if (!row) return createDefaultBookingSettings();
    let schedule = row.schedule;
    if (typeof schedule === 'string') {
        try { schedule = JSON.parse(schedule); } catch (_) { schedule = {}; }
    }
    return normalizeBookingSettings({
        ...(schedule || {}),
        bookingStyle: row.booking_style,
        allowCustomTime: row.allow_custom_time
    });
};

const fetchBookingSettings = async barberId => {
    const result = await pool.query(
        'SELECT booking_style, schedule, allow_custom_time FROM barber_settings WHERE barber_id = $1',
        [barberId]
    );
    return readBookingSettingsRow(result.rows[0]);
};

const getUserRole = user => user.email === ADMIN_EMAIL && user.is_admin !== false ? 'administrador' : 'operador';
const normalizePermissions = (permissions, isAdmin = false) => {
    if (isAdmin) return { ...DEFAULT_PERMISSIONS };

    let source = permissions;
    if (typeof source === 'string') {
        try { source = JSON.parse(source); } catch (_) { source = {}; }
    }

    return Object.fromEntries(PERMISSION_KEYS.map(key => [key, source?.[key] !== false]));
};

// Auth Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, message: 'Token não fornecido' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(401).json({ success: false, message: 'Token inválido' });
        req.user = user;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user?.role !== 'administrador' || req.user?.email !== ADMIN_EMAIL) {
        return res.status(403).json({ success: false, message: 'Acesso restrito ao administrador.' });
    }
    next();
};

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, '..')));

// DB Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

let appointmentPaymentSchemaPromise;
const ensureAppointmentPaymentSchema = () => {
    if (!appointmentPaymentSchemaPromise) {
        appointmentPaymentSchemaPromise = pool.query("ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'paid'")
            .then(() => pool.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_paid_at TIMESTAMP'))
            .catch(error => {
            appointmentPaymentSchemaPromise = null;
            throw error;
            });
    }
    return appointmentPaymentSchemaPromise;
};

const requireAnyPermission = (...permissions) => async (req, res, next) => {
    if (req.user?.role === 'administrador' && req.user?.email === ADMIN_EMAIL) return next();

    try {
        const result = await pool.query(
            'SELECT permissions, is_active FROM barbers WHERE id = $1',
            [req.user?.id]
        );
        const currentUser = result.rows[0];

        if (!currentUser || currentUser.is_active === false) {
            return res.status(403).json({ success: false, message: 'Usuário inativo.' });
        }

        const granted = normalizePermissions(currentUser.permissions);
        if (!permissions.some(permission => granted[permission])) {
            return res.status(403).json({ success: false, message: 'Você não possui permissão para esta área.' });
        }

        req.user.permissions = granted;
        next();
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Erro ao validar permissões.' });
    }
};

const requireOwnBarber = (req, res, next) => {
    if (Number(req.user?.id) !== Number(req.params.barberId)) {
        return res.status(403).json({ success: false, message: 'Acesso restrito à sua barbearia.' });
    }
    next();
};

pool.on('connect', () => {
    console.log('✅ Connected to Neon PostgreSQL');
    // Ensure commission column exists (one-off migration)
    pool.query('ALTER TABLE professionals ADD COLUMN IF NOT EXISTS commission DECIMAL(5,2) DEFAULT 0').catch(e => console.error('Migration error:', e));
    pool.query('ALTER TABLE professionals ADD COLUMN IF NOT EXISTS product_commission DECIMAL(5,2) DEFAULT 0').catch(e => console.error('Migration error:', e));
    pool.query('ALTER TABLE services ADD COLUMN IF NOT EXISTS photo_url TEXT').catch(e => console.error('Migration error:', e));
    pool.query(`
        CREATE TABLE IF NOT EXISTS monthly_goals (
            id SERIAL PRIMARY KEY,
            barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
            goal_year INTEGER NOT NULL,
            goal_month INTEGER NOT NULL CHECK (goal_month BETWEEN 1 AND 12),
            amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (barber_id, goal_year, goal_month)
        )
    `).catch(e => console.error('Migration error (monthly_goals):', e));
    pool.query(`
        CREATE TABLE IF NOT EXISTS barber_settings (
            barber_id INTEGER PRIMARY KEY REFERENCES barbers(id) ON DELETE CASCADE,
            booking_style VARCHAR(30) NOT NULL DEFAULT 'classic',
            schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
            allow_custom_time BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `).catch(e => console.error('Migration error (barber_settings):', e));
    pool.query(`
        CREATE TABLE IF NOT EXISTS inventory (
            id SERIAL PRIMARY KEY,
            barber_id INTEGER REFERENCES barbers(id),
            item_name VARCHAR(255) NOT NULL,
            description TEXT,
            photo_url TEXT,
            quantity INTEGER DEFAULT 0,
            unit VARCHAR(50) DEFAULT 'un',
            min_quantity INTEGER DEFAULT 5,
            unit_price DECIMAL(10,2) DEFAULT 0,
            generate_commission BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `).catch(e => console.error('Migration error (inventory):', e));
    // Ensure new columns exist if table was already there
    pool.query('ALTER TABLE inventory ADD COLUMN IF NOT EXISTS description TEXT').catch(() => {});
    pool.query('ALTER TABLE inventory ADD COLUMN IF NOT EXISTS photo_url TEXT').catch(() => {});
    pool.query('ALTER TABLE inventory ADD COLUMN IF NOT EXISTS unit_price DECIMAL(10,2) DEFAULT 0').catch(() => {});
    pool.query('ALTER TABLE inventory ADD COLUMN IF NOT EXISTS generate_commission BOOLEAN NOT NULL DEFAULT TRUE').catch(() => {});

    // Sales table migration
    pool.query(`
        CREATE TABLE IF NOT EXISTS sales (
            id SERIAL PRIMARY KEY,
            barber_id INTEGER REFERENCES barbers(id),
            item_id INTEGER REFERENCES inventory(id),
            client_id INTEGER REFERENCES clients(id),
            professional_id INTEGER REFERENCES professionals(id),
            quantity INTEGER NOT NULL,
            price_at_sale DECIMAL(10,2) DEFAULT 0,
            total_price DECIMAL(10,2) NOT NULL,
            commission_rate DECIMAL(5,2) DEFAULT 0,
            commission_value DECIMAL(10,2) DEFAULT 0,
            sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `).catch(e => console.error('Migration error (sales):', e));
    // Migration for existing table
    pool.query('ALTER TABLE sales ADD COLUMN IF NOT EXISTS item_id INTEGER REFERENCES inventory(id)')
        .then(() => pool.query('UPDATE sales SET item_id = inventory_id WHERE item_id IS NULL AND inventory_id IS NOT NULL'))
        .catch(() => {});
    pool.query('ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id)').catch(() => {});
    pool.query('ALTER TABLE sales ADD COLUMN IF NOT EXISTS professional_id INTEGER REFERENCES professionals(id)').catch(() => {});
    pool.query('ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_at_sale DECIMAL(10,2) DEFAULT 0').catch(() => {});
    pool.query('ALTER TABLE sales ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5,2) DEFAULT 0').catch(() => {});
    pool.query('ALTER TABLE sales ADD COLUMN IF NOT EXISTS commission_value DECIMAL(10,2) DEFAULT 0').catch(() => {});
    pool.query('ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP').catch(() => {});
    pool.query('ALTER TABLE barbers ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE').catch(() => {});
    pool.query("ALTER TABLE barbers ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb").catch(() => {});
    pool.query('ALTER TABLE barbers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE').catch(() => {});
    pool.query(
        'UPDATE barbers SET permissions = $1::jsonb WHERE permissions IS NULL OR permissions = $2::jsonb',
        [JSON.stringify(DEFAULT_PERMISSIONS), '{}']
    ).catch(() => {});
    pool.query('UPDATE barbers SET is_admin = FALSE WHERE email <> $1', [ADMIN_EMAIL]).catch(() => {});
    pool.query(`
        INSERT INTO barbers (email, password, shop_name, is_admin)
        VALUES ($1, $2, $3, TRUE)
        ON CONFLICT (email) DO UPDATE
        SET password = EXCLUDED.password,
            shop_name = EXCLUDED.shop_name,
            is_admin = TRUE
    `, [
        ADMIN_EMAIL,
        '$2b$10$ZXI327CmozKhoq54XaBFYeROX3ZYM8cfk98Oo4dTDzLgmsR9V46lm',
        'Painel BarberPoint'
    ]).catch(e => console.error('Migration error (admin user):', e));

});

// API Routes
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM barbers WHERE email = $1', [email]);
        const user = result.rows[0];
        
        if (user && user.is_active !== false) {
            let isMatch = false;
            try {
                isMatch = await bcrypt.compare(password, user.password);
            } catch (e) {
                console.warn('Senha em formato antigo ou inválido. Considere resetar a senha.');
            }

            if (isMatch) {
                const role = getUserRole(user);
                const permissions = normalizePermissions(user.permissions, role === 'administrador');
                const token = jwt.sign(
                    { id: user.id, email: user.email, role },
                    JWT_SECRET,
                    { expiresIn: '7d' }
                );
                return res.json({ 
                    success: true, 
                    token, 
                    user: {
                        id: user.id,
                        email: user.email,
                        shop: user.shop_name,
                        role,
                        isAdmin: role === 'administrador',
                        permissions,
                        isActive: user.is_active !== false
                    }
                });
            }
        }
        res.status(401).json({ success: false, message: 'E-mail ou senha incorretos.' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/session', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM barbers WHERE id = $1', [req.user.id]);
        const user = result.rows[0];

        if (!user || user.is_active === false) {
            return res.status(403).json({ success: false, message: 'Usuário inativo.' });
        }

        const role = getUserRole(user);
        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                shop: user.shop_name,
                role,
                isAdmin: role === 'administrador',
                permissions: normalizePermissions(user.permissions, role === 'administrador'),
                isActive: true
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Erro ao validar sessão.' });
    }
});

app.post('/api/register', (req, res) => {
    res.status(403).json({
        success: false,
        message: 'Novos usuários devem ser criados pelo painel de Administração.'
    });
});

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, email, shop_name, (email = $1) AS is_admin, permissions, is_active, created_at
            FROM barbers
            ORDER BY (email = $1) DESC, created_at DESC
        `, [ADMIN_EMAIL]);
        res.json({ success: true, users: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Erro ao carregar usuários.' });
    }
});

app.post('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    const { email, password, shop, role = 'operador', permissions, isActive = true } = req.body;

    if (!email || !password || !shop) {
        return res.status(400).json({ success: false, message: 'Informe nome da barbearia, e-mail e senha.' });
    }

    if (role === 'administrador' && email !== ADMIN_EMAIL) {
        return res.status(400).json({ success: false, message: 'Somente o usuário principal pode ter cargo administrador.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const isAdmin = role === 'administrador' && email === ADMIN_EMAIL;
        const normalizedPermissions = normalizePermissions(permissions, isAdmin);
        const result = await pool.query(
            `INSERT INTO barbers (email, password, shop_name, is_admin, permissions, is_active)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)
             RETURNING id, email, shop_name, (email = $7) AS is_admin, permissions, is_active, created_at`,
            [email, hashedPassword, shop, isAdmin, JSON.stringify(normalizedPermissions), Boolean(isActive), ADMIN_EMAIL]
        );

        res.status(201).json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error(err);
        if (err.code === '23505') {
            return res.status(409).json({ success: false, message: 'Este e-mail já está cadastrado.' });
        }
        res.status(500).json({ success: false, message: 'Erro ao criar usuário.' });
    }
});

app.patch('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { email, password, shop, role = 'operador', permissions, isActive = true } = req.body;

    if (!email || !shop) {
        return res.status(400).json({ success: false, message: 'Informe nome da barbearia e e-mail.' });
    }

    try {
        const existing = await pool.query('SELECT id, email FROM barbers WHERE id = $1', [id]);
        const user = existing.rows[0];

        if (!user) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        }

        const isMainAdmin = user.email === ADMIN_EMAIL;

        if (isMainAdmin && email !== ADMIN_EMAIL) {
            return res.status(400).json({ success: false, message: 'O e-mail do administrador principal não pode ser alterado.' });
        }

        if (role === 'administrador' && email !== ADMIN_EMAIL) {
            return res.status(400).json({ success: false, message: 'Somente o usuário principal pode ter cargo administrador.' });
        }

        if (isMainAdmin && role !== 'administrador') {
            return res.status(400).json({ success: false, message: 'O administrador principal não pode virar operador.' });
        }

        if (isMainAdmin && isActive === false) {
            return res.status(400).json({ success: false, message: 'O administrador principal não pode ser desativado.' });
        }

        const newIsAdmin = role === 'administrador' && email === ADMIN_EMAIL;
        const normalizedPermissions = normalizePermissions(permissions, newIsAdmin);

        let result;
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            result = await pool.query(
                `UPDATE barbers
                 SET email = $1, shop_name = $2, password = $3, is_admin = $4, permissions = $5::jsonb, is_active = $6
                 WHERE id = $7
                 RETURNING id, email, shop_name, (email = $8) AS is_admin, permissions, is_active, created_at`,
                [email, shop, hashedPassword, newIsAdmin, JSON.stringify(normalizedPermissions), Boolean(isActive), id, ADMIN_EMAIL]
            );
        } else {
            result = await pool.query(
                `UPDATE barbers
                 SET email = $1, shop_name = $2, is_admin = $3, permissions = $4::jsonb, is_active = $5
                 WHERE id = $6
                 RETURNING id, email, shop_name, (email = $7) AS is_admin, permissions, is_active, created_at`,
                [email, shop, newIsAdmin, JSON.stringify(normalizedPermissions), Boolean(isActive), id, ADMIN_EMAIL]
            );
        }

        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error(err);
        if (err.code === '23505') {
            return res.status(409).json({ success: false, message: 'Este e-mail já está cadastrado.' });
        }
        res.status(500).json({ success: false, message: 'Erro ao atualizar usuário.' });
    }
});

app.get('/api/business-settings/:barberId', authenticateToken, requireAnyPermission('configuracoes'), requireOwnBarber, async (req, res) => {
    try {
        const settings = await fetchBookingSettings(req.params.barberId);
        res.json({ success: true, settings });
    } catch (err) {
        console.error('Erro ao carregar configurações da barbearia:', err);
        res.status(500).json({ success: false, message: 'Não foi possível carregar as configurações.' });
    }
});

app.patch('/api/business-settings/:barberId', authenticateToken, requireAnyPermission('configuracoes'), requireOwnBarber, async (req, res) => {
    const { bookingStyle, intervalMinutes, breakEnabled, breakStart, breakEnd, allowCustomTime, weeklySchedule } = req.body || {};
    const settings = normalizeBookingSettings({
        bookingStyle,
        intervalMinutes,
        breakEnabled,
        breakStart,
        breakEnd,
        allowCustomTime,
        weeklySchedule
    });

    const invalidDay = Object.values(settings.weeklySchedule).some(day => (
        day.enabled && timeToMinutes(day.start) >= timeToMinutes(day.end)
    ));
    const invalidBreak = settings.breakEnabled && timeToMinutes(settings.breakStart) >= timeToMinutes(settings.breakEnd);
    if (invalidDay || invalidBreak) {
        return res.status(400).json({ success: false, message: 'Confira os horários de abertura, fechamento e intervalo.' });
    }

    try {
        const schedule = JSON.stringify({
            intervalMinutes: settings.intervalMinutes,
            breakEnabled: settings.breakEnabled,
            breakStart: settings.breakStart,
            breakEnd: settings.breakEnd,
            weeklySchedule: settings.weeklySchedule
        });
        const result = await pool.query(`
            INSERT INTO barber_settings (barber_id, booking_style, schedule, allow_custom_time, updated_at)
            VALUES ($1, $2, $3::jsonb, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (barber_id) DO UPDATE SET
                booking_style = EXCLUDED.booking_style,
                schedule = EXCLUDED.schedule,
                allow_custom_time = EXCLUDED.allow_custom_time,
                updated_at = CURRENT_TIMESTAMP
            RETURNING booking_style, schedule, allow_custom_time
        `, [req.params.barberId, settings.bookingStyle, schedule, settings.allowCustomTime]);

        res.json({ success: true, settings: readBookingSettingsRow(result.rows[0]) });
    } catch (err) {
        console.error('Erro ao salvar configurações da barbearia:', err);
        res.status(500).json({ success: false, message: 'Não foi possível salvar as configurações.' });
    }
});

app.get('/api/public/settings/:barberId', async (req, res) => {
    const barberId = Number.parseInt(req.params.barberId, 10);
    if (!Number.isInteger(barberId) || barberId <= 0) {
        return res.status(400).json({ success: false, message: 'Barbearia inválida.' });
    }

    try {
        const settings = await fetchBookingSettings(barberId);
        res.json({ success: true, settings });
    } catch (err) {
        console.error('Erro ao carregar configurações públicas:', err);
        // Keep the public booking link usable while a new database is finishing its migration.
        res.json({ success: true, settings: createDefaultBookingSettings() });
    }
});

app.get('/api/appointments/:barberId', authenticateToken, requireAnyPermission('dashboard', 'agenda', 'billing', 'comissoes'), async (req, res) => {
    try {
        await ensureAppointmentPaymentSchema();
        const { barberId } = req.params;
        // Fetch all appointments for the calendar (pending, completed, canceled)
        const result = await pool.query(`
            SELECT a.*, COALESCE(s.name, 'Servi\u00E7o removido') as service_name,
                   COALESCE(s.price, 0) as service_price, COALESCE(s.duration, '-') as service_duration,
                   p.name as professional_name
            FROM appointments a
            LEFT JOIN services s ON a.service_id = s.id
            LEFT JOIN professionals p ON a.professional_id = p.id
            WHERE a.barber_id = $1
            ORDER BY a.appointment_date ASC, a.appointment_time ASC
        `, [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/appointments/booked/list', async (req, res) => {
    const { barberId, professionalId, date } = req.query;
    try {
        const result = await pool.query(`
            SELECT SUBSTRING(appointment_time::text, 1, 5) as time
            FROM appointments
            WHERE barber_id = $1 AND professional_id = $2 AND appointment_date = $3 AND status != 'canceled'
        `, [barberId, professionalId, date]);
        res.json(result.rows.map(r => r.time));
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// Public lookup for clients: only completed appointments from the barber shop
// in the reservation link are returned, using a normalized WhatsApp number.
app.get('/api/public/appointments', async (req, res) => {
    const barberId = Number.parseInt(req.query.barberId, 10);
    const phone = String(req.query.phone || '').replace(/\D/g, '');

    if (!Number.isInteger(barberId) || barberId <= 0) {
        return res.status(400).json({ success: false, message: 'Barbearia invÃ¡lida.' });
    }

    if (!/^\d{8,15}$/.test(phone)) {
        return res.status(400).json({ success: false, message: 'Informe um WhatsApp vÃ¡lido.' });
    }

    try {
        const result = await pool.query(`
            SELECT a.id,
                   TO_CHAR(a.appointment_date, 'DD/MM/YYYY') AS appointment_date_display,
                   SUBSTRING(a.appointment_time::text, 1, 5) AS appointment_time_display,
                   COALESCE(s.name, 'ServiÃ§o removido') AS service_name,
                   COALESCE(p.name, 'Equipe') AS professional_name
            FROM appointments a
            LEFT JOIN services s ON a.service_id = s.id
            LEFT JOIN professionals p ON a.professional_id = p.id
            WHERE a.barber_id = $1
              AND regexp_replace(COALESCE(a.client_phone, ''), '[^0-9]', '', 'g') = $2
              AND a.status = 'completed'
            ORDER BY a.appointment_date DESC, a.appointment_time DESC
        `, [barberId, phone]);

        res.json({ success: true, appointments: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'NÃ£o foi possÃ­vel consultar os agendamentos.' });
    }
});

app.post('/api/appointments', async (req, res) => {
    const { barberId, serviceId, professionalId, clientName, clientPhone, time, date } = req.body;
    try {
        await ensureAppointmentPaymentSchema();
        // Use provided date or today if not provided
        const apptDate = date || new Date().toISOString().split('T')[0];
        const normalizedTime = String(time || '').slice(0, 5);
        if (!BOOKING_TIME_PATTERN.test(normalizedTime)) {
            return res.status(400).json({ success: false, message: 'Informe um horário válido.' });
        }

        const bookingSettings = await fetchBookingSettings(barberId);
        const dateParts = String(apptDate).slice(0, 10).split('-').map(Number);
        const dateDay = dateParts.length === 3 && dateParts.every(Number.isInteger)
            ? new Date(dateParts[0], dateParts[1] - 1, dateParts[2]).getDay()
            : null;
        const daySettings = dateDay === null ? null : bookingSettings.weeklySchedule[String(dateDay)];
        const configuredTimes = getAvailableBookingTimes(bookingSettings, apptDate);

        if (!daySettings?.enabled || (!bookingSettings.allowCustomTime && !configuredTimes.includes(normalizedTime))) {
            return res.status(400).json({ success: false, message: 'Este horário não está disponível para a barbearia.' });
        }

        // 0. Check for collision
        const collision = await pool.query(`
            SELECT id FROM appointments 
            WHERE barber_id = $1 AND professional_id = $2 AND appointment_date = $3 AND appointment_time = $4 AND status != 'canceled'
        `, [barberId, professionalId, apptDate, normalizedTime]);

        if (collision.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'Este horário já foi reservado para este barbeiro.' });
        }

        // 1. Insert the appointment
        const result = await pool.query(
            'INSERT INTO appointments (barber_id, service_id, professional_id, client_name, client_phone, appointment_time, appointment_date) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [barberId, serviceId, professionalId, clientName, clientPhone, normalizedTime, apptDate]
        );

        // 2. Sync with CRM (clients table) - Always ensure client exists for this Name + Phone combo
        await pool.query(`
            INSERT INTO clients (barber_id, name, phone)
            VALUES ($1, $2, $3)
            ON CONFLICT (barber_id, name, phone) DO NOTHING
        `, [barberId, clientName, clientPhone]).catch(async (err) => {
            // Manual fallback if needed
            const check = await pool.query('SELECT id FROM clients WHERE barber_id = $1 AND name = $2 AND phone = $3', [barberId, clientName, clientPhone]);
            if (check.rows.length === 0) {
                await pool.query('INSERT INTO clients (barber_id, name, phone) VALUES ($1, $2, $3)', [barberId, clientName, clientPhone]);
            }
        });

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/appointments/:id', authenticateToken, requireAnyPermission('agenda'), async (req, res) => {
    const { id } = req.params;
    const { status, paymentStatus, serviceId, professionalId, clientName, clientPhone, time, date } = req.body;
    try {
        await ensureAppointmentPaymentSchema();
        const hasAppointmentChanges = [serviceId, professionalId, clientName, clientPhone, time, date]
            .some(value => value !== undefined);
        const normalizedPaymentStatus = paymentStatus === 'pending' ? 'pending' : (paymentStatus === 'paid' ? 'paid' : null);

        if (!hasAppointmentChanges) {
            if (status === 'completed') {
                await pool.query(`
                    UPDATE appointments
                    SET status = $1,
                        payment_status = $2::varchar,
                        payment_paid_at = CASE WHEN $2::varchar = 'paid' THEN CURRENT_TIMESTAMP ELSE NULL END
                    WHERE id = $3
                `, [status, normalizedPaymentStatus || 'paid', id]);
            } else {
                await pool.query('UPDATE appointments SET status = $1 WHERE id = $2', [status, id]);
            }
            return res.json({ success: true });
        }

        if (!serviceId || !professionalId || !clientName || !clientPhone || !time || !date) {
            return res.status(400).json({ success: false, message: 'Preencha todos os dados do agendamento.' });
        }

        const collision = await pool.query(`
            SELECT id FROM appointments
            WHERE barber_id = (SELECT barber_id FROM appointments WHERE id = $1)
              AND professional_id = $2
              AND appointment_date = $3
              AND appointment_time = $4
              AND status != 'canceled'
              AND id <> $1
        `, [id, professionalId, date, time]);

        if (collision.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'Este horário já está reservado para este barbeiro.' });
        }

        const result = await pool.query(`
            UPDATE appointments
            SET service_id = $1, professional_id = $2, client_name = $3,
                client_phone = $4, appointment_time = $5, appointment_date = $6
            WHERE id = $7
            RETURNING *
        `, [serviceId, professionalId, clientName, clientPhone, time, date, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Agendamento não encontrado.' });
        }

        await pool.query(`
            INSERT INTO clients (barber_id, name, phone)
            SELECT barber_id, $1, $2 FROM appointments WHERE id = $3
            ON CONFLICT (barber_id, name, phone) DO NOTHING
        `, [clientName, clientPhone, id]);

        res.json({ success: true, appointment: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/appointments/:id/payment', authenticateToken, requireAnyPermission('agenda', 'clientes'), async (req, res) => {
    const { id } = req.params;
    try {
        await ensureAppointmentPaymentSchema();
        const result = await pool.query(`
            UPDATE appointments
            SET payment_status = 'paid', payment_paid_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'completed'
            RETURNING id, payment_status, payment_paid_at
        `, [id]);

        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: 'Atendimento pendente não encontrado.' });
        }

        res.json({ success: true, appointment: result.rows[0] });
    } catch (err) {
        console.error('Erro ao confirmar pagamento do atendimento:', err);
        res.status(500).json({ success: false, message: 'Não foi possível confirmar o pagamento.' });
    }
});

app.delete('/api/appointments/:id', authenticateToken, requireAnyPermission('agenda'), async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM appointments WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/stats/:barberId', authenticateToken, requireAnyPermission('dashboard', 'billing'), async (req, res) => {
    try {
        const { barberId } = req.params;
        // Total from services
        const svcResult = await pool.query(`
            SELECT COALESCE(SUM(COALESCE(s.price, 0)), 0) as revenue, COUNT(a.id) as count
            FROM appointments a
            LEFT JOIN services s ON a.service_id = s.id
            WHERE a.barber_id = $1 AND a.status = 'completed'
        `, [barberId]);

        // Total from sales
        const salesResult = await pool.query(`
            SELECT COALESCE(SUM(total_price), 0) as revenue
            FROM sales
            WHERE barber_id = $1
        `, [barberId]);

        const serviceRev = parseFloat(svcResult.rows[0].revenue);
        const salesRev = parseFloat(salesResult.rows[0].revenue);

        res.json({
            revenue: serviceRev + salesRev,
            count: parseInt(svcResult.rows[0].count),
            serviceRevenue: serviceRev,
            salesRevenue: salesRev
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/monthly-goals/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('billing'), async (req, res) => {
    const barberId = Number(req.params.barberId);
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month) || new Date().getMonth() + 1;

    if (!Number.isInteger(year) || year < 2000 || !Number.isInteger(month) || month < 1 || month > 12) {
        return res.status(400).json({ success: false, message: 'Per\u00EDodo inv\u00E1lido.' });
    }

    try {
        const result = await pool.query(`
            SELECT goal_year, goal_month, amount
            FROM monthly_goals
            WHERE barber_id = $1 AND goal_year = $2 AND goal_month = $3
        `, [barberId, year, month]);
        const goal = result.rows[0];

        res.json({
            year,
            month,
            amount: goal ? Number(goal.amount) : DEFAULT_MONTHLY_GOAL,
            defined: Boolean(goal)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'N\u00E3o foi poss\u00EDvel carregar a meta mensal.' });
    }
});

app.put('/api/monthly-goals/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('billing'), async (req, res) => {
    const barberId = Number(req.params.barberId);
    const year = Number(req.body.year) || new Date().getFullYear();
    const month = Number(req.body.month) || new Date().getMonth() + 1;
    const amount = Number(String(req.body.amount ?? '').replace(',', '.'));

    if (!Number.isInteger(year) || year < 2000 || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Informe um valor de meta v\u00E1lido.' });
    }

    try {
        const result = await pool.query(`
            INSERT INTO monthly_goals (barber_id, goal_year, goal_month, amount)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (barber_id, goal_year, goal_month)
            DO UPDATE SET amount = EXCLUDED.amount, updated_at = CURRENT_TIMESTAMP
            RETURNING goal_year, goal_month, amount
        `, [barberId, year, month, amount]);

        res.json({ success: true, ...result.rows[0], amount: Number(result.rows[0].amount), defined: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'N\u00E3o foi poss\u00EDvel salvar a meta mensal.' });
    }
});

// Clients API - Fixed last_service_date to use appointment_date for business logic
app.get('/api/clients/:barberId', authenticateToken, requireAnyPermission('clientes'), async (req, res) => {
    try {
        await ensureAppointmentPaymentSchema();
        const { barberId } = req.params;
        const result = await pool.query(`
            SELECT c.*, 
                   MAX(a.appointment_date) as last_service_date,
                   (SELECT a2.appointment_time 
                    FROM appointments a2 
                    WHERE a2.client_name = c.name AND a2.client_phone = c.phone 
                    ORDER BY a2.appointment_date DESC, a2.appointment_time DESC LIMIT 1) as scheduled_time,
                   COUNT(a.id) as total_appointments,
                   COUNT(a.id) FILTER (WHERE a.status = 'completed' AND a.payment_status = 'pending') as pending_payment_count,
                   COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.payment_status = 'pending' THEN COALESCE(s.price, 0) ELSE 0 END), 0) as pending_payment_total
            FROM clients c
            LEFT JOIN appointments a ON c.name = a.client_name AND c.phone = a.client_phone
            LEFT JOIN services s ON a.service_id = s.id
            WHERE c.barber_id = $1
            GROUP BY c.id
            ORDER BY last_service_date DESC, c.name ASC
        `, [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/clients/:id/history', authenticateToken, requireAnyPermission('clientes'), async (req, res) => {
    try {
        await ensureAppointmentPaymentSchema();
        const { id } = req.params;
        const clientResult = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
        const client = clientResult.rows[0];

        if (!client) return res.status(404).send('Client not found');

        const appointmentsResult = await pool.query(`
            SELECT a.*, COALESCE(s.name, 'Servi\u00E7o removido') as service_name,
                   COALESCE(s.price, 0) as service_price, p.name as professional_name
            FROM appointments a
            LEFT JOIN services s ON a.service_id = s.id
            LEFT JOIN professionals p ON a.professional_id = p.id
            WHERE a.client_name = $1 AND a.client_phone = $2
            ORDER BY a.appointment_date DESC, a.appointment_time DESC
        `, [client.name, client.phone]);

        const statsResult = await pool.query(`
            SELECT COALESCE(SUM(COALESCE(s.price, 0)), 0) as total_spent,
                   COUNT(a.id) as service_count,
                   COUNT(a.id) FILTER (WHERE a.status = 'completed' AND a.payment_status = 'pending') as pending_payment_count,
                   COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.payment_status = 'pending' THEN COALESCE(s.price, 0) ELSE 0 END), 0) as pending_payment_total
            FROM appointments a
            LEFT JOIN services s ON a.service_id = s.id
            WHERE a.client_name = $1 AND a.client_phone = $2 AND a.status = 'completed'
        `, [client.name, client.phone]);

        res.json({
            client,
            history: appointmentsResult.rows,
            stats: statsResult.rows[0]
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/clients/:id', authenticateToken, requireAnyPermission('clientes'), async (req, res) => {
    const { id } = req.params;
    let db;
    try {
        const clientRes = await pool.query('SELECT name, phone FROM clients WHERE id = $1', [id]);
        if (clientRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Cliente não encontrado' });
        
        const { name, phone } = clientRes.rows[0];
        db = await pool.connect();
        
        await db.query('BEGIN');
        // Delete associated appointments
        await db.query('DELETE FROM appointments WHERE client_name = $1 AND client_phone = $2', [name, phone]);

        // Keep sales history, but remove the reference to the deleted client.
        await db.query('UPDATE sales SET client_id = NULL WHERE client_id = $1', [id]);
        
        // Delete the client
        await db.query('DELETE FROM clients WHERE id = $1', [id]);
        await db.query('COMMIT');
        
        res.json({ success: true });
    } catch (err) {
        if (db) await db.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).send('Server Error');
    } finally {
        if (db) db.release();
    }
});

// Services API
app.get('/api/services/:barberId', async (req, res) => {
    try {
        const { barberId } = req.params;
        const result = await pool.query('SELECT * FROM services WHERE barber_id = $1 ORDER BY name ASC', [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/services', authenticateToken, requireAnyPermission('servicos'), async (req, res) => {
    const { barberId, name, price, duration, photoUrl } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO services (barber_id, name, price, duration, photo_url) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [barberId, name, price, duration, photoUrl]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/services/:id', authenticateToken, requireAnyPermission('servicos'), async (req, res) => {
    const { id } = req.params;
    const { name, price, duration, photoUrl } = req.body;
    try {
        await pool.query(
            'UPDATE services SET name = $1, price = $2, duration = $3, photo_url = $4 WHERE id = $5',
            [name, price, duration, photoUrl, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/services/:id', authenticateToken, requireAnyPermission('servicos'), async (req, res) => {
    const { id } = req.params;
    let db;
    try {
        db = await pool.connect();
        await db.query('BEGIN');

        const serviceResult = await db.query(
            'SELECT id, name FROM services WHERE id = $1 AND barber_id = $2',
            [id, req.user.id]
        );
        if (serviceResult.rows.length === 0) {
            await db.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Servi\u00E7o n\u00E3o encontrado.' });
        }

        await db.query('DELETE FROM professional_services WHERE service_id = $1', [id]);
        // Keep historical appointments, even when their catalog service is removed.
        await db.query('UPDATE appointments SET service_id = NULL WHERE service_id = $1', [id]);
        await db.query('DELETE FROM services WHERE id = $1 AND barber_id = $2', [id, req.user.id]);
        await db.query('COMMIT');

        res.json({ success: true, service: serviceResult.rows[0] });
    } catch (err) {
        if (db) await db.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ success: false, message: 'N\u00E3o foi poss\u00EDvel excluir o servi\u00E7o.' });
    } finally {
        if (db) db.release();
    }
});

// Professionals API
app.get('/api/professionals/:barberId', async (req, res) => {
    try {
        const { barberId } = req.params;
        const result = await pool.query(`
            SELECT p.*, 
                   json_agg(json_build_object('id', s.id, 'name', s.name)) FILTER (WHERE s.id IS NOT NULL) as services
            FROM professionals p
            LEFT JOIN professional_services ps ON p.id = ps.professional_id
            LEFT JOIN services s ON ps.service_id = s.id
            WHERE p.barber_id = $1
            GROUP BY p.id
            ORDER BY p.name ASC
        `, [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/professionals', authenticateToken, requireAnyPermission('barbeiros'), async (req, res) => {
    const { barberId, name, phone, photoUrl, commission, productCommission } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO professionals (barber_id, name, phone, photo_url, commission, product_commission) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [barberId, name, phone, photoUrl, commission || 0, productCommission || 0]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/professional-services/:profId', async (req, res) => {
    try {
        const { profId } = req.params;
        const result = await pool.query(`
            SELECT s.* FROM services s
            JOIN professional_services ps ON s.id = ps.service_id
            WHERE ps.professional_id = $1
        `, [profId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/professional-services', authenticateToken, requireAnyPermission('barbeiros'), async (req, res) => {
    const { profId, serviceIds } = req.body;
    try {
        await pool.query('DELETE FROM professional_services WHERE professional_id = $1', [profId]);
        if (serviceIds && serviceIds.length > 0) {
            const values = serviceIds.map(sid => `(${profId}, ${sid})`).join(',');
            await pool.query(`INSERT INTO professional_services (professional_id, service_id) VALUES ${values}`);
        }
        res.send('Linked successfully');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/professionals/:id', authenticateToken, requireAnyPermission('barbeiros'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone, photoUrl, commission, productCommission } = req.body;
        await pool.query(
            'UPDATE professionals SET name = $1, phone = $2, photo_url = $3, commission = $4, product_commission = $5 WHERE id = $6',
            [name, phone, photoUrl, commission || 0, productCommission || 0, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/professionals/:id', authenticateToken, requireAnyPermission('barbeiros'), async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM professional_services WHERE professional_id = $1', [id]);
        await pool.query('DELETE FROM professionals WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/clients', authenticateToken, requireAnyPermission('clientes'), async (req, res) => {
    const { barberId, name, phone, notes } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO clients (barber_id, name, phone, notes) VALUES ($1, $2, $3, $4) RETURNING *',
            [barberId, name, phone, notes]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// Inventory API (Revolutionary)
app.get('/api/inventory/:barberId', authenticateToken, requireAnyPermission('estoque', 'vendas'), async (req, res) => {
    try {
        const { barberId } = req.params;
        const result = await pool.query('SELECT * FROM inventory WHERE barber_id = $1 ORDER BY item_name ASC', [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/inventory', authenticateToken, requireAnyPermission('estoque'), async (req, res) => {
    const { barberId, itemName, description, photoUrl, quantity, unit, minQuantity, unitPrice, generateCommission } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO inventory (barber_id, item_name, description, photo_url, quantity, unit, min_quantity, unit_price, generate_commission) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
            [barberId, itemName, description, photoUrl, quantity, unit, minQuantity, unitPrice || 0, generateCommission !== false]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/inventory/:id', authenticateToken, requireAnyPermission('estoque'), async (req, res) => {
    const { id } = req.params;
    const { itemName, description, photoUrl, quantity, unit, minQuantity, unitPrice, generateCommission } = req.body;
    try {
        const result = await pool.query(
            `UPDATE inventory SET 
                item_name = COALESCE($1, item_name), 
                description = COALESCE($2, description),
                photo_url = COALESCE($3, photo_url),
                quantity = COALESCE($4, quantity), 
                unit = COALESCE($5, unit), 
                min_quantity = COALESCE($6, min_quantity), 
                unit_price = COALESCE($7, unit_price),
                generate_commission = COALESCE($8, generate_commission)
            WHERE id = $9 RETURNING *`,
            [itemName, description, photoUrl, quantity, unit, minQuantity, unitPrice, generateCommission, id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/inventory/:id', authenticateToken, requireAnyPermission('estoque'), async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM inventory WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// Sales API Endpoints
app.get('/api/sales/:barberId', authenticateToken, requireAnyPermission('vendas', 'comissoes', 'billing'), async (req, res) => {
    const { barberId } = req.params;
    try {
        const result = await pool.query(
            `SELECT s.*, i.item_name, c.name as client_name, p.name as professional_name
             FROM sales s 
             LEFT JOIN inventory i ON s.item_id = i.id 
             LEFT JOIN clients c ON s.client_id = c.id
             LEFT JOIN professionals p ON s.professional_id = p.id
             WHERE s.barber_id = $1 
             ORDER BY s.sale_date DESC`,
            [barberId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching sales:', err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/sales', authenticateToken, requireAnyPermission('vendas'), async (req, res) => {
    const { inventoryId, quantity, totalPrice, unitPrice, clientId, professionalId, commissionRate: reqCommRate } = req.body;
    const barberId = req.body.barberId || req.user.id;
    
    if (!inventoryId || !quantity) return res.status(400).send('Dados incompletos');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const inventoryResult = await client.query(
            'SELECT generate_commission FROM inventory WHERE id = $1 AND barber_id = $2 AND quantity >= $3 FOR UPDATE',
            [inventoryId, barberId, parseInt(quantity)]
        );

        if (inventoryResult.rowCount === 0) {
            throw new Error('Produto nÃ£o encontrado ou estoque insuficiente');
        }

        const generatesCommission = inventoryResult.rows[0].generate_commission !== false;
        
        let commissionRate = generatesCommission && reqCommRate !== undefined ? parseFloat(reqCommRate) : 0;
        let commissionValue = 0;

        if (generatesCommission && professionalId) {
            // If commissionRate wasn't provided in body, fetch from professional
            if (reqCommRate === undefined) {
                const profRes = await client.query('SELECT product_commission FROM professionals WHERE id = $1', [professionalId]);
                if (profRes.rowCount > 0) {
                    commissionRate = parseFloat(profRes.rows[0].product_commission || 0);
                }
            }
            commissionValue = parseFloat(totalPrice) * (commissionRate / 100);
        }

        // 1. Record the sale (using item_id and price_at_sale)
        const saleResult = await client.query(
            'INSERT INTO sales (barber_id, item_id, client_id, professional_id, quantity, price_at_sale, total_price, commission_rate, commission_value) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
            [barberId, inventoryId, clientId || null, professionalId || null, parseInt(quantity), parseFloat(unitPrice), parseFloat(totalPrice), commissionRate, commissionValue]
        );

        // 2. Decrement inventory
        const invUpdate = await client.query(
            'UPDATE inventory SET quantity = quantity - $1 WHERE id = $2 AND barber_id = $3 RETURNING quantity',
            [parseInt(quantity), inventoryId, barberId]
        );

        if (invUpdate.rowCount === 0) {
            throw new Error('Produto não encontrado ou estoque insuficiente');
        }

        await client.query('COMMIT');
        res.json(saleResult.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).send(err.message || 'Server Error');
    } finally {
        client.release();
    }
});

app.delete('/api/sales/:id', authenticateToken, requireAnyPermission('vendas'), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Get sale details to revert inventory
        const sale = await client.query('SELECT item_id, quantity, barber_id FROM sales WHERE id = $1', [id]);
        if (sale.rowCount > 0) {
            const { item_id, quantity, barber_id } = sale.rows[0];
            // 2. Revert inventory
            await client.query('UPDATE inventory SET quantity = quantity + $1 WHERE id = $2 AND barber_id = $3', [quantity, item_id, barber_id]);
        }
        
        // 3. Delete sale
        await client.query('DELETE FROM sales WHERE id = $1', [id]);
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).send('Server Error');
    } finally {
        client.release();
    }
});

app.delete('/api/inventory/:id', authenticateToken, requireAnyPermission('estoque'), async (req, res) => {
    const { id } = req.params;
    try {
        // Sales that reference this item will have item_id set to NULL due to ON DELETE SET NULL
        // or I can just delete it if the constraint allows.
        // For safety, I'll check if there are sales first or just try to delete.
        await pool.query('DELETE FROM inventory WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Não é possível excluir este item pois ele possui registros de venda associados.');
    }
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`🚀 BarberPoint Server running on http://localhost:${port}`);
    });
}

module.exports = app;
