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
const PERMISSION_KEYS = ['dashboard', 'agenda', 'billing', 'despesas', 'clientes', 'vendas', 'estoque', 'barbeiros', 'comissoes', 'servicos', 'configuracoes', 'relatorios'];
const DEFAULT_PERMISSIONS = Object.fromEntries(PERMISSION_KEYS.map(key => [key, true]));
const PAYMENT_METHODS = ['cash', 'pix', 'card'];
const APPOINTMENT_STATUSES = ['pending', 'confirmed', 'arrived', 'in_progress', 'completed', 'no_show', 'canceled'];

const BOOKING_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const BOOKING_DAYS = [0, 1, 2, 3, 4, 5, 6];

const createDefaultBookingSettings = () => ({
    bookingStyle: 'classic',
    intervalMinutes: 60,
    breakEnabled: true,
    breakStart: '12:00',
    breakEnd: '14:00',
    allowCustomTime: true,
    blockedDates: [],
    blockedTimes: [],
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

    const blockedDates = Array.isArray(source.blockedDates)
        ? source.blockedDates.map(value => String(value).slice(0, 10)).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
        : [];
    const blockedTimes = Array.isArray(source.blockedTimes)
        ? source.blockedTimes.map(block => ({
            date: String(block?.date || '').slice(0, 10),
            start: BOOKING_TIME_PATTERN.test(String(block?.start || '')) ? String(block.start) : null,
            end: BOOKING_TIME_PATTERN.test(String(block?.end || '')) ? String(block.end) : null,
            reason: String(block?.reason || '').trim().slice(0, 160)
        })).filter(block => /^\d{4}-\d{2}-\d{2}$/.test(block.date) && ((block.start && block.end && timeToMinutes(block.start) < timeToMinutes(block.end)) || (!block.start && !block.end)))
        : [];

    return {
        bookingStyle: validStyles.includes(source.bookingStyle) ? source.bookingStyle : defaults.bookingStyle,
        intervalMinutes: [15, 30, 60].includes(interval) ? interval : defaults.intervalMinutes,
        breakEnabled: source.breakEnabled !== false,
        breakStart,
        breakEnd,
        allowCustomTime: source.allowCustomTime !== false,
        blockedDates,
        blockedTimes,
        weeklySchedule
    };
};

const timeToMinutes = value => {
    const [hours, minutes] = String(value || '').split(':').map(Number);
    return (hours * 60) + minutes;
};

const durationToMinutes = value => {
    const text = String(value ?? '').trim().toLowerCase().replace(',', '.');
    const match = text.match(/(\d+(?:\.\d+)?)\s*(hora|horas|h|minuto|minutos|min|m)?/i);
    if (!match) return 30;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return 30;
    return /^h/i.test(match[2] || '') ? Math.round(amount * 60) : Math.round(amount);
};

const rangesOverlap = (startA, endA, startB, endB) => startA < endB && startB < endA;

const isValidDateValue = value => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.getFullYear() === Number(match[1])
        && date.getMonth() === Number(match[2]) - 1
        && date.getDate() === Number(match[3]);
};

const getCurrentBookingClock = () => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date()).map(part => [part.type, part.value]));

    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        minutes: (Number(parts.hour) * 60) + Number(parts.minute)
    };
};

const isBookingTimeInPast = (dateValue, timeValue) => {
    const current = getCurrentBookingClock();
    const date = String(dateValue || '').slice(0, 10);
    const time = timeToMinutes(timeValue);
    return date < current.date || (date === current.date && time <= current.minutes);
};

const getBookingDayConfig = (settings, dateValue) => {
    const normalized = normalizeBookingSettings(settings);
    const dateKey = String(dateValue || '').slice(0, 10);
    const parts = String(dateValue || '').slice(0, 10).split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return null;

    const day = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
    const dayConfig = normalized.weeklySchedule[String(day)];
    if (!dayConfig?.enabled || normalized.blockedDates.includes(dateKey)) return null;

    return { normalized, dateKey, dayConfig };
};

const isBookingWindowBlocked = (settings, dateValue, timeValue, durationMinutes = 30) => {
    const context = getBookingDayConfig(settings, dateValue);
    if (!context) return true;

    const start = timeToMinutes(timeValue);
    const end = start + Math.max(1, Number(durationMinutes) || 30);
    const scheduleStart = timeToMinutes(context.dayConfig.start);
    const scheduleEnd = timeToMinutes(context.dayConfig.end);
    if (start < scheduleStart || end > scheduleEnd) return true;

    const breakStart = timeToMinutes(context.normalized.breakStart);
    const breakEnd = timeToMinutes(context.normalized.breakEnd);
    if (context.normalized.breakEnabled && breakStart < breakEnd && rangesOverlap(start, end, breakStart, breakEnd)) return true;

    return context.normalized.blockedTimes.some(block => (
        block.date === context.dateKey
        && block.start
        && block.end
        && rangesOverlap(start, end, timeToMinutes(block.start), timeToMinutes(block.end))
    ));
};

const getAvailableBookingTimes = (settings, dateValue, durationMinutes = 30) => {
    const context = getBookingDayConfig(settings, dateValue);
    if (!context) return [];

    const duration = Math.max(1, Number(durationMinutes) || 30);
    const start = timeToMinutes(context.dayConfig.start);
    const end = timeToMinutes(context.dayConfig.end);
    const times = [];

    for (let minutes = start; minutes + duration <= end; minutes += context.normalized.intervalMinutes) {
        if (isBookingWindowBlocked(context.normalized, dateValue, `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`, duration)) continue;
        times.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
    }

    return times;
};

const isBookingTimeBlocked = (settings, dateValue, timeValue, durationMinutes = 30) => (
    isBookingWindowBlocked(settings, dateValue, timeValue, durationMinutes)
);

const getBookingDateValue = () => getCurrentBookingClock().date;

const getBookingMonthStart = () => {
    const date = getBookingDateValue();
    return `${date.slice(0, 7)}-01`;
};

const getBookingSelection = async (db, barberId, serviceId, professionalId) => {
    const result = await db.query(`
        SELECT s.id AS service_id, s.duration, p.id AS professional_id
        FROM barbers b
        JOIN services s ON s.barber_id = b.id AND s.id = $2
        JOIN professional_services ps ON ps.service_id = s.id AND ps.professional_id = $3
        JOIN professionals p ON p.id = ps.professional_id AND p.barber_id = b.id
        WHERE b.id = $1 AND b.is_active = TRUE
    `, [barberId, serviceId, professionalId]);
    return result.rows[0] || null;
};

const findAppointmentConflict = async (db, {
    barberId,
    professionalId,
    appointmentDate,
    appointmentTime,
    durationMinutes,
    excludeId = null
}) => {
    const result = await db.query(`
        SELECT a.id, a.appointment_time, COALESCE(s.duration, '30') AS service_duration
        FROM appointments a
        LEFT JOIN services s ON s.id = a.service_id
        WHERE a.barber_id = $1
          AND a.professional_id = $2
          AND a.appointment_date = $3
          AND a.status NOT IN ('canceled', 'no_show')
          AND ($4::integer IS NULL OR a.id <> $4)
    `, [barberId, professionalId, appointmentDate, excludeId]);

    return result.rows.find(row => rangesOverlap(
        timeToMinutes(appointmentTime),
        timeToMinutes(appointmentTime) + durationMinutes,
        timeToMinutes(row.appointment_time),
        timeToMinutes(row.appointment_time) + durationToMinutes(row.service_duration)
    )) || null;
};

const readBookingSettingsRow = (row, overrides = {}) => {
    if (!row) return normalizeBookingSettings(overrides);
    let schedule = row.schedule;
    if (typeof schedule === 'string') {
        try { schedule = JSON.parse(schedule); } catch (_) { schedule = {}; }
    }
    return normalizeBookingSettings({
        ...(schedule || {}),
        bookingStyle: row.booking_style,
        allowCustomTime: row.allow_custom_time,
        ...overrides
    });
};

const fetchBookingSettings = async barberId => {
    const result = await pool.query(
        'SELECT booking_style, schedule, allow_custom_time FROM barber_settings WHERE barber_id = $1',
        [barberId]
    );
    const blocks = await pool.query(
        'SELECT block_date, start_time, end_time, reason FROM booking_blocks WHERE barber_id = $1 ORDER BY block_date ASC, start_time ASC NULLS FIRST',
        [barberId]
    ).catch(() => ({ rows: [] }));
    const blockedDates = blocks.rows.filter(block => !block.start_time && !block.end_time).map(block => String(block.block_date).slice(0, 10));
    const blockedTimes = blocks.rows.filter(block => block.start_time && block.end_time).map(block => ({
        date: String(block.block_date).slice(0, 10),
        start: String(block.start_time).slice(0, 5),
        end: String(block.end_time).slice(0, 5),
        reason: block.reason || ''
    }));
    return readBookingSettingsRow(result.rows[0], { blockedDates, blockedTimes });
};

const getUserRole = user => user.is_admin === true ? 'administrador' : 'operador';
const normalizePermissions = (permissions, isAdmin = false) => {
    if (isAdmin) return { ...DEFAULT_PERMISSIONS };

    let source = permissions;
    if (typeof source === 'string') {
        try { source = JSON.parse(source); } catch (_) { source = {}; }
    }

    return Object.fromEntries(PERMISSION_KEYS.map(key => [key, source?.[key] === true]));
};

const slugifyBusinessName = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

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
    if (req.user?.role !== 'administrador') {
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

let operationalSchemaPromise;
const ensureOperationalSchema = () => {
    if (!operationalSchemaPromise) {
        operationalSchemaPromise = pool.query(`
            CREATE TABLE IF NOT EXISTS sales (
                id SERIAL PRIMARY KEY,
                barber_id INTEGER REFERENCES barbers(id) ON DELETE CASCADE,
                item_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL,
                client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
                professional_id INTEGER REFERENCES professionals(id) ON DELETE SET NULL,
                quantity INTEGER NOT NULL DEFAULT 1,
                price_at_sale DECIMAL(10,2) NOT NULL DEFAULT 0,
                total_price DECIMAL(10,2) NOT NULL DEFAULT 0,
                commission_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
                commission_value DECIMAL(10,2) NOT NULL DEFAULT 0,
                payment_method VARCHAR(20) NOT NULL DEFAULT 'cash',
                sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'cash';
            ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'cash';
            ALTER TABLE clients ADD COLUMN IF NOT EXISTS birthday DATE;
            ALTER TABLE clients ADD COLUMN IF NOT EXISTS loyalty_points INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE clients ADD COLUMN IF NOT EXISTS referral_code VARCHAR(40);
            ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMP;
            ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS notes TEXT;
            ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS converted_at TIMESTAMP;
            ALTER TABLE inventory ADD COLUMN IF NOT EXISTS supplier VARCHAR(160);
            ALTER TABLE inventory ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10,2) NOT NULL DEFAULT 0;
            ALTER TABLE services ADD COLUMN IF NOT EXISTS is_package BOOLEAN NOT NULL DEFAULT FALSE;
            ALTER TABLE services ADD COLUMN IF NOT EXISTS package_sessions INTEGER;

            CREATE TABLE IF NOT EXISTS professional_services (
                professional_id INTEGER REFERENCES professionals(id) ON DELETE CASCADE,
                service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
                PRIMARY KEY (professional_id, service_id)
            );

            CREATE TABLE IF NOT EXISTS booking_blocks (
                id SERIAL PRIMARY KEY,
                barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
                block_date DATE NOT NULL,
                start_time TIME,
                end_time TIME,
                reason VARCHAR(160),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS waitlist_entries (
                id SERIAL PRIMARY KEY,
                barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
                client_name VARCHAR(120) NOT NULL,
                client_phone VARCHAR(30) NOT NULL,
                service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
                professional_id INTEGER REFERENCES professionals(id) ON DELETE SET NULL,
                desired_date DATE,
                notes TEXT,
                status VARCHAR(20) NOT NULL DEFAULT 'waiting',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS cash_registers (
                id SERIAL PRIMARY KEY,
                barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
                register_date DATE NOT NULL DEFAULT CURRENT_DATE,
                opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
                closing_balance DECIMAL(12,2),
                status VARCHAR(20) NOT NULL DEFAULT 'open',
                notes TEXT,
                opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                closed_at TIMESTAMP,
                UNIQUE (barber_id, register_date)
            );
            CREATE TABLE IF NOT EXISTS cash_movements (
                id SERIAL PRIMARY KEY,
                barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
                cash_register_id INTEGER REFERENCES cash_registers(id) ON DELETE CASCADE,
                source_type VARCHAR(30) NOT NULL,
                source_id INTEGER,
                payment_method VARCHAR(20) NOT NULL DEFAULT 'cash',
                amount DECIMAL(12,2) NOT NULL,
                description VARCHAR(200) NOT NULL,
                movement_date DATE NOT NULL DEFAULT CURRENT_DATE,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (barber_id, source_type, source_id)
            );
            CREATE TABLE IF NOT EXISTS inventory_movements (
                id SERIAL PRIMARY KEY,
                barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
                inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
                movement_type VARCHAR(20) NOT NULL,
                quantity INTEGER NOT NULL,
                unit_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
                reason VARCHAR(200),
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS loyalty_transactions (
                id SERIAL PRIMARY KEY,
                barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
                client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
                points INTEGER NOT NULL,
                reason VARCHAR(160) NOT NULL,
                source_type VARCHAR(30),
                source_id INTEGER,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS audit_logs (
                id SERIAL PRIMARY KEY,
                barber_id INTEGER REFERENCES barbers(id) ON DELETE SET NULL,
                actor_id INTEGER REFERENCES barbers(id) ON DELETE SET NULL,
                action VARCHAR(80) NOT NULL,
                entity_type VARCHAR(50),
                entity_id INTEGER,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS referrals (
                id SERIAL PRIMARY KEY,
                barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
                referrer_client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
                referred_client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
                referrer_bonus INTEGER NOT NULL DEFAULT 50,
                referred_bonus INTEGER NOT NULL DEFAULT 10,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (barber_id, referred_client_id)
            );
            CREATE INDEX IF NOT EXISTS appointments_barber_date_idx ON appointments (barber_id, appointment_date, appointment_time);
            CREATE INDEX IF NOT EXISTS waitlist_entries_barber_status_idx ON waitlist_entries (barber_id, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS cash_movements_barber_date_idx ON cash_movements (barber_id, movement_date);
            CREATE INDEX IF NOT EXISTS inventory_movements_item_idx ON inventory_movements (inventory_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS audit_logs_barber_date_idx ON audit_logs (barber_id, created_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS loyalty_transactions_source_idx ON loyalty_transactions (barber_id, source_type, source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS referrals_barber_idx ON referrals (barber_id, created_at DESC);
        `).catch(error => {
            operationalSchemaPromise = null;
            throw error;
        });
    }
    return operationalSchemaPromise;
};

const normalizePaymentMethod = value => PAYMENT_METHODS.includes(String(value || '').toLowerCase())
    ? String(value).toLowerCase()
    : 'cash';

const getPaymentLabel = value => ({ cash: 'Dinheiro', pix: 'Pix', card: 'Cartão' }[value] || 'Dinheiro');

const logAudit = (req, action, entityType = null, entityId = null, metadata = {}) => {
    return pool.query(
        'INSERT INTO audit_logs (barber_id, actor_id, action, entity_type, entity_id, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
        [req.user?.id || null, req.user?.id || null, action, entityType, entityId, JSON.stringify(metadata)]
    ).catch(error => console.error('Audit log error:', error.message));
};

const ensureCashRegister = async (db, barberId, movementDate, openingBalance = 0) => {
    const result = await db.query(`
        INSERT INTO cash_registers (barber_id, register_date, opening_balance)
        VALUES ($1, $2, $3)
        ON CONFLICT (barber_id, register_date) DO UPDATE SET barber_id = EXCLUDED.barber_id
        RETURNING *
    `, [barberId, movementDate, Number(openingBalance) || 0]);
    return result.rows[0];
};

const upsertCashMovement = async ({ db = pool, barberId, sourceType, sourceId, amount, paymentMethod = 'cash', description, movementDate }) => {
    const date = String(movementDate || getBookingDateValue()).slice(0, 10);
    const register = await ensureCashRegister(db, barberId, date);
    const normalizedAmount = Number(amount);
    const normalizedMethod = normalizePaymentMethod(paymentMethod);

    if (sourceId !== null && sourceId !== undefined) {
        await db.query(`
            INSERT INTO cash_movements (barber_id, cash_register_id, source_type, source_id, payment_method, amount, description, movement_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (barber_id, source_type, source_id) DO UPDATE SET
                cash_register_id = EXCLUDED.cash_register_id,
                payment_method = EXCLUDED.payment_method,
                amount = EXCLUDED.amount,
                description = EXCLUDED.description,
                movement_date = EXCLUDED.movement_date
        `, [barberId, register.id, sourceType, sourceId, normalizedMethod, normalizedAmount, description, date]);
    } else {
        await db.query(`
            INSERT INTO cash_movements (barber_id, cash_register_id, source_type, payment_method, amount, description, movement_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [barberId, register.id, sourceType, normalizedMethod, normalizedAmount, description, date]);
    }
};

const removeCashMovement = async (db, barberId, sourceType, sourceId) => {
    await db.query('DELETE FROM cash_movements WHERE barber_id = $1 AND source_type = $2 AND source_id = $3', [barberId, sourceType, sourceId]);
};

const syncAppointmentCashMovement = async (db, appointmentId, status, paymentStatus, paymentMethod) => {
    const result = await db.query(`
        SELECT a.barber_id, a.client_name, a.client_phone, a.appointment_date, a.payment_method,
               COALESCE(s.price, 0) AS service_price, COALESCE(s.name, 'Atendimento') AS service_name
        FROM appointments a
        LEFT JOIN services s ON s.id = a.service_id
        WHERE a.id = $1
    `, [appointmentId]);
    const appointment = result.rows[0];
    if (!appointment) return;

    if (status === 'completed' && paymentStatus !== 'pending') {
        await upsertCashMovement({
            db,
            barberId: appointment.barber_id,
            sourceType: 'appointment',
            sourceId: appointmentId,
            amount: Number(appointment.service_price || 0),
            paymentMethod: paymentMethod || appointment.payment_method,
            description: `${appointment.service_name} · ${appointment.client_name}`,
            movementDate: appointment.appointment_date
        });

        const referralCode = `BP-${appointment.barber_id}-${Date.now().toString(36).toUpperCase()}`;
        const clientResult = await db.query(`
            INSERT INTO clients (barber_id, name, phone, referral_code)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (barber_id, name, phone) DO UPDATE SET phone = EXCLUDED.phone
            RETURNING id
        `, [appointment.barber_id, appointment.client_name, appointment.client_phone || '', referralCode]);
        const clientId = clientResult.rows[0]?.id;
        const points = Math.max(1, Math.floor(Number(appointment.service_price || 0)));
        if (clientId && points > 0) {
            const loyaltyResult = await db.query(`
                INSERT INTO loyalty_transactions (barber_id, client_id, points, reason, source_type, source_id)
                VALUES ($1, $2, $3, $4, 'appointment', $5)
                ON CONFLICT (barber_id, source_type, source_id) DO NOTHING
                RETURNING id
            `, [appointment.barber_id, clientId, points, `Atendimento: ${appointment.service_name}`, appointmentId]);
            if (loyaltyResult.rows.length) {
                await db.query('UPDATE clients SET loyalty_points = loyalty_points + $1 WHERE id = $2 AND barber_id = $3', [points, clientId, appointment.barber_id]);
            }
        }
    } else {
        await removeCashMovement(db, appointment.barber_id, 'appointment', appointmentId);
    }
};

const recordInventoryMovement = async (db, barberId, inventoryId, movementType, quantity, unitCost = 0, reason = null) => {
    if (!quantity) return;
    await db.query(`
        INSERT INTO inventory_movements (barber_id, inventory_id, movement_type, quantity, unit_cost, reason)
        VALUES ($1, $2, $3, $4, $5, $6)
    `, [barberId, inventoryId, movementType, quantity, Number(unitCost) || 0, reason]);
};

let marketingLeadSchemaPromise;
const ensureMarketingLeadSchema = () => {
    if (!marketingLeadSchemaPromise) {
        marketingLeadSchemaPromise = pool.query(`
            CREATE TABLE IF NOT EXISTS marketing_leads (
                id SERIAL PRIMARY KEY,
                name VARCHAR(120) NOT NULL,
                phone VARCHAR(30) NOT NULL,
                source VARCHAR(50) NOT NULL DEFAULT 'landing_demo',
                status VARCHAR(20) NOT NULL DEFAULT 'new',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                contacted_at TIMESTAMP,
                next_action_at TIMESTAMP,
                notes TEXT,
                converted_at TIMESTAMP
            )
        `).then(() => pool.query('ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMP'))
            .then(() => pool.query('ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS notes TEXT'))
            .then(() => pool.query('ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS converted_at TIMESTAMP'))
            .then(() => pool.query(
            'CREATE INDEX IF NOT EXISTS marketing_leads_created_at_idx ON marketing_leads (created_at DESC)'
        )).catch(error => {
            marketingLeadSchemaPromise = null;
            throw error;
        });
    }
    return marketingLeadSchemaPromise;
};

let appointmentPaymentSchemaPromise;
const ensureAppointmentPaymentSchema = () => {
    if (!appointmentPaymentSchemaPromise) {
        appointmentPaymentSchemaPromise = pool.query("ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'paid'")
            .then(() => pool.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_paid_at TIMESTAMP'))
            .then(() => pool.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMP'))
            .then(() => pool.query("ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'cash'"))
            .catch(error => {
            appointmentPaymentSchemaPromise = null;
            throw error;
            });
    }
    return appointmentPaymentSchemaPromise;
};

let profileSchemaPromise;
const ensureProfileSchema = () => {
    if (!profileSchemaPromise) {
        profileSchemaPromise = pool.query('ALTER TABLE barbers ADD COLUMN IF NOT EXISTS owner_name VARCHAR(120)')
            .then(() => pool.query('ALTER TABLE barbers ADD COLUMN IF NOT EXISTS owner_phone VARCHAR(30)'))
            .catch(error => {
                profileSchemaPromise = null;
                throw error;
            });
    }
    return profileSchemaPromise;
};

ensureProfileSchema().catch(error => console.error('Profile schema migration error:', error.message));

ensureOperationalSchema().catch(error => console.error('Operational schema migration error:', error.message));

const requireAnyPermission = (...permissions) => async (req, res, next) => {
    if (req.user?.role === 'administrador') return next();

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

// Status changes are intentionally available from the Dashboard queue. Editing
// the appointment details remains restricted to the Agenda permission.
const requireAppointmentMutationPermission = (req, res, next) => {
    const detailFields = ['serviceId', 'professionalId', 'clientName', 'clientPhone', 'time', 'date'];
    const isEditingDetails = detailFields.some(field => req.body?.[field] !== undefined);
    return requireAnyPermission(...(isEditingDetails ? ['agenda'] : ['agenda', 'dashboard']))(req, res, next);
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
    pool.query('ALTER TABLE services ADD COLUMN IF NOT EXISTS is_package BOOLEAN NOT NULL DEFAULT FALSE').catch(e => console.error('Migration error:', e));
    pool.query('ALTER TABLE services ADD COLUMN IF NOT EXISTS package_sessions INTEGER').catch(e => console.error('Migration error:', e));
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
        CREATE TABLE IF NOT EXISTS expenses (
            id SERIAL PRIMARY KEY,
            barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
            description VARCHAR(160) NOT NULL,
            category VARCHAR(60) NOT NULL DEFAULT 'Outros',
            amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
            expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `).catch(e => console.error('Migration error (expenses):', e));
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
            payment_method VARCHAR(20) NOT NULL DEFAULT 'cash',
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
    pool.query("ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'cash'").catch(() => {});
    pool.query('ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP').catch(() => {});
    pool.query('ALTER TABLE barbers ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE').catch(() => {});
    pool.query("ALTER TABLE barbers ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb").catch(() => {});
    pool.query('ALTER TABLE barbers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE').catch(() => {});
    pool.query(
        'UPDATE barbers SET permissions = $1::jsonb WHERE permissions IS NULL OR permissions = $2::jsonb',
        [JSON.stringify(DEFAULT_PERMISSIONS), '{}']
    ).catch(() => {});
    pool.query(`
        INSERT INTO barbers (email, password, shop_name, is_admin)
        VALUES ($1, $2, $3, TRUE)
        ON CONFLICT (email) DO UPDATE
        SET password = EXCLUDED.password,
            shop_name = COALESCE(NULLIF(barbers.shop_name, ''), EXCLUDED.shop_name),
            is_admin = TRUE
    `, [
        ADMIN_EMAIL,
        '$2b$10$ZXI327CmozKhoq54XaBFYeROX3ZYM8cfk98Oo4dTDzLgmsR9V46lm',
        'Painel Gestano'
    ]).catch(e => console.error('Migration error (admin user):', e));

});

// API Routes
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        await ensureProfileSchema();
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
                        shop_name: user.shop_name,
                        name: user.owner_name || '',
                        phone: user.owner_phone || '',
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
        await ensureProfileSchema();
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
                shop_name: user.shop_name,
                name: user.owner_name || '',
                phone: user.owner_phone || '',
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

app.patch('/api/profile', authenticateToken, async (req, res) => {
    const shopName = String(req.body?.shopName || '').trim().replace(/\s+/g, ' ');
    const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
    const phone = String(req.body?.phone || '').trim();
    const phoneDigits = phone.replace(/\D/g, '');

    if (shopName.length < 2 || shopName.length > 120) {
        return res.status(400).json({ success: false, message: 'Informe um nome válido para a barbearia.' });
    }
    if (name.length < 2 || name.length > 120) {
        return res.status(400).json({ success: false, message: 'Informe um nome válido.' });
    }
    if (phone && (phoneDigits.length < 10 || phoneDigits.length > 11)) {
        return res.status(400).json({ success: false, message: 'Informe um WhatsApp válido ou deixe o campo vazio.' });
    }

    try {
        await ensureProfileSchema();
        const result = await pool.query(
            'UPDATE barbers SET shop_name = $1, owner_name = $2, owner_phone = $3 WHERE id = $4 RETURNING id, email, shop_name, owner_name, owner_phone, is_admin, permissions, is_active',
            [shopName, name, phone, req.user.id]
        );
        const user = result.rows[0];

        if (!user) {
            return res.status(404).json({ success: false, message: 'Conta não encontrada.' });
        }

        const role = getUserRole(user);
        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                shop: user.shop_name,
                shop_name: user.shop_name,
                name: user.owner_name || '',
                phone: user.owner_phone || '',
                role,
                isAdmin: role === 'administrador',
                permissions: normalizePermissions(user.permissions, role === 'administrador'),
                isActive: user.is_active !== false
            }
        });
    } catch (err) {
        console.error('Erro ao atualizar perfil:', err);
        res.status(500).json({ success: false, message: 'Não foi possível atualizar os dados da conta.' });
    }
});

app.post('/api/register', (req, res) => {
    res.status(403).json({
        success: false,
        message: 'Novos usuários devem ser criados pelo painel de Administração.'
    });
});

app.post('/api/public/marketing-leads', async (req, res) => {
    const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
    const phone = String(req.body?.phone || '').trim();
    const source = String(req.body?.source || 'landing_demo').trim().slice(0, 50) || 'landing_demo';

    if (name.length < 2 || name.length > 120) {
        return res.status(400).json({ success: false, message: 'Informe um nome válido.' });
    }

    const phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 10 || phoneDigits.length > 13) {
        return res.status(400).json({ success: false, message: 'Informe um telefone válido com DDD.' });
    }

    try {
        await ensureMarketingLeadSchema();
        const result = await pool.query(`
            INSERT INTO marketing_leads (name, phone, source)
            VALUES ($1, $2, $3)
            RETURNING id, name, phone, source, status, created_at
        `, [name, phone, source]);

        res.status(201).json({ success: true, lead: result.rows[0] });
    } catch (err) {
        console.error('Erro ao salvar triagem de marketing:', err);
        res.status(500).json({ success: false, message: 'Não foi possível registrar sua solicitação.' });
    }
});

app.get('/api/admin/marketing-leads', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await ensureMarketingLeadSchema();
        const result = await pool.query(`
            SELECT id, name, phone, source, status, created_at, contacted_at, next_action_at, notes, converted_at
            FROM marketing_leads
            ORDER BY created_at DESC
        `);
        res.json({ success: true, leads: result.rows });
    } catch (err) {
        console.error('Erro ao carregar leads de marketing:', err);
        res.status(500).json({ success: false, message: 'Não foi possível carregar as triagens.' });
    }
});

app.patch('/api/admin/marketing-leads/:id', authenticateToken, requireAdmin, async (req, res) => {
    const status = String(req.body?.status || '').trim();
    const nextActionAt = req.body?.nextActionAt ? new Date(req.body.nextActionAt) : null;
    const notes = String(req.body?.notes || '').trim().slice(0, 1000) || null;
    if (!['new', 'contacted', 'demo_scheduled', 'converted', 'lost', 'archived'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Status inválido.' });
    }

    try {
        await ensureMarketingLeadSchema();
        const result = await pool.query(`
            UPDATE marketing_leads
            SET status = $1,
                contacted_at = CASE WHEN $1 IN ('contacted', 'demo_scheduled', 'converted') THEN COALESCE(contacted_at, CURRENT_TIMESTAMP) ELSE contacted_at END,
                converted_at = CASE WHEN $1 = 'converted' THEN COALESCE(converted_at, CURRENT_TIMESTAMP) ELSE converted_at END,
                next_action_at = $2,
                notes = COALESCE($3, notes)
            WHERE id = $4
            RETURNING id, name, phone, source, status, created_at, contacted_at, next_action_at, notes, converted_at
        `, [status, nextActionAt && !Number.isNaN(nextActionAt.getTime()) ? nextActionAt : null, notes, req.params.id]);

        if (!result.rowCount) {
            return res.status(404).json({ success: false, message: 'Triagem não encontrada.' });
        }

        res.json({ success: true, lead: result.rows[0] });
    } catch (err) {
        console.error('Erro ao atualizar lead de marketing:', err);
        res.status(500).json({ success: false, message: 'Não foi possível atualizar a triagem.' });
    }
});

app.get('/api/admin/audit-logs', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await ensureOperationalSchema();
        const result = await pool.query(`
            SELECT l.id, l.action, l.entity_type, l.entity_id, l.metadata, l.created_at,
                   b.shop_name AS actor_name, b.email AS actor_email
            FROM audit_logs l
            LEFT JOIN barbers b ON b.id = l.actor_id
            ORDER BY l.created_at DESC
            LIMIT 200
        `);
        res.json({ success: true, logs: result.rows });
    } catch (err) {
        console.error('Erro ao carregar logs:', err);
        res.status(500).json({ success: false, message: 'Nao foi possivel carregar os logs.' });
    }
});

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, email, shop_name, is_admin, (email = $1) AS is_main_admin, permissions, is_active, created_at
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

    if (!['operador', 'administrador'].includes(role)) {
        return res.status(400).json({ success: false, message: 'Perfil de usuário inválido.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const isAdmin = role === 'administrador';
        const normalizedPermissions = normalizePermissions(permissions, isAdmin);
        const result = await pool.query(
            `INSERT INTO barbers (email, password, shop_name, is_admin, permissions, is_active)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)
             RETURNING id, email, shop_name, is_admin, (email = $7) AS is_main_admin, permissions, is_active, created_at`,
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

    if (!['operador', 'administrador'].includes(role)) {
        return res.status(400).json({ success: false, message: 'Perfil de usuário inválido.' });
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

        if (isMainAdmin && role !== 'administrador') {
            return res.status(400).json({ success: false, message: 'O administrador principal não pode virar operador.' });
        }

        if (isMainAdmin && isActive === false) {
            return res.status(400).json({ success: false, message: 'O administrador principal não pode ser desativado.' });
        }

        const newIsAdmin = role === 'administrador';
        const normalizedPermissions = normalizePermissions(permissions, newIsAdmin);

        let result;
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            result = await pool.query(
                `UPDATE barbers
                 SET email = $1, shop_name = $2, password = $3, is_admin = $4, permissions = $5::jsonb, is_active = $6
                 WHERE id = $7
                 RETURNING id, email, shop_name, is_admin, (email = $8) AS is_main_admin, permissions, is_active, created_at`,
                [email, shop, hashedPassword, newIsAdmin, JSON.stringify(normalizedPermissions), Boolean(isActive), id, ADMIN_EMAIL]
            );
        } else {
            result = await pool.query(
                `UPDATE barbers
                 SET email = $1, shop_name = $2, is_admin = $3, permissions = $4::jsonb, is_active = $5
                 WHERE id = $6
                 RETURNING id, email, shop_name, is_admin, (email = $7) AS is_main_admin, permissions, is_active, created_at`,
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

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ success: false, message: 'Usuário inválido.' });
    }

    if (userId === Number(req.user?.id)) {
        return res.status(400).json({ success: false, message: 'A conta atualmente conectada não pode ser excluída.' });
    }

    try {
        const existing = await pool.query('SELECT id, email FROM barbers WHERE id = $1', [userId]);
        const user = existing.rows[0];

        if (!user) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        }

        if (user.email === ADMIN_EMAIL) {
            return res.status(400).json({ success: false, message: 'A conta principal não pode ser excluída.' });
        }

        await pool.query('DELETE FROM barbers WHERE id = $1', [userId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao excluir usuário:', err);
        if (err.code === '23503') {
            return res.status(409).json({ success: false, message: 'Não é possível excluir esta conta porque existem dados vinculados. Desative o usuário para bloquear o acesso.' });
        }
        res.status(500).json({ success: false, message: 'Erro ao excluir usuário.' });
    }
});

app.get('/api/business-settings/:barberId', authenticateToken, requireAnyPermission('configuracoes'), requireOwnBarber, async (req, res) => {
    try {
        await ensureOperationalSchema();
        const settings = await fetchBookingSettings(req.params.barberId);
        res.json({ success: true, settings });
    } catch (err) {
        console.error('Erro ao carregar configurações da barbearia:', err);
        res.status(500).json({ success: false, message: 'Não foi possível carregar as configurações.' });
    }
});

app.patch('/api/business-settings/:barberId', authenticateToken, requireAnyPermission('configuracoes'), requireOwnBarber, async (req, res) => {
    const { bookingStyle, intervalMinutes, breakEnabled, breakStart, breakEnd, allowCustomTime, weeklySchedule, blockedDates, blockedTimes } = req.body || {};
    const settings = normalizeBookingSettings({
        bookingStyle,
        intervalMinutes,
        breakEnabled,
        breakStart,
        breakEnd,
        allowCustomTime,
        weeklySchedule,
        blockedDates,
        blockedTimes
    });

    const invalidDay = Object.values(settings.weeklySchedule).some(day => (
        day.enabled && timeToMinutes(day.start) >= timeToMinutes(day.end)
    ));
    const invalidBreak = settings.breakEnabled && timeToMinutes(settings.breakStart) >= timeToMinutes(settings.breakEnd);
    if (invalidDay || invalidBreak) {
        return res.status(400).json({ success: false, message: 'Confira os horários de abertura, fechamento e intervalo.' });
    }

    try {
        await ensureOperationalSchema();
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

        await pool.query('DELETE FROM booking_blocks WHERE barber_id = $1', [req.params.barberId]);
        for (const date of settings.blockedDates) {
            await pool.query('INSERT INTO booking_blocks (barber_id, block_date, reason) VALUES ($1, $2, $3)', [req.params.barberId, date, 'Dia bloqueado']);
        }
        for (const block of settings.blockedTimes) {
            await pool.query('INSERT INTO booking_blocks (barber_id, block_date, start_time, end_time, reason) VALUES ($1, $2, $3, $4, $5)', [req.params.barberId, block.date, block.start, block.end, block.reason || 'Horário bloqueado']);
        }

        res.json({ success: true, settings: await fetchBookingSettings(req.params.barberId) });
    } catch (err) {
        console.error('Erro ao salvar configurações da barbearia:', err);
        res.status(500).json({ success: false, message: 'Não foi possível salvar as configurações.' });
    }
});

app.get('/api/public/business/:slug', async (req, res) => {
    const slug = slugifyBusinessName(req.params.slug);
    if (!slug) {
        return res.status(400).json({ success: false, message: 'Link da barbearia inválido.' });
    }

    try {
        const result = await pool.query('SELECT id, shop_name FROM barbers');
        const business = result.rows.find(row => slugifyBusinessName(row.shop_name) === slug);
        if (!business) {
            return res.status(404).json({ success: false, message: 'Barbearia não encontrada.' });
        }

        res.json({
            success: true,
            business: {
                id: business.id,
                name: business.shop_name,
                slug
            }
        });
    } catch (err) {
        console.error('Erro ao resolver link público:', err);
        res.status(500).json({ success: false, message: 'Não foi possível carregar a barbearia.' });
    }
});

app.get('/api/public/settings/:barberId', async (req, res) => {
    const barberId = Number.parseInt(req.params.barberId, 10);
    if (!Number.isInteger(barberId) || barberId <= 0) {
        return res.status(400).json({ success: false, message: 'Barbearia inválida.' });
    }

    try {
        await ensureOperationalSchema();
        const settings = await fetchBookingSettings(barberId);
        res.json({ success: true, settings });
    } catch (err) {
        console.error('Erro ao carregar configurações públicas:', err);
        // Keep the public booking link usable while a new database is finishing its migration.
        res.json({ success: true, settings: createDefaultBookingSettings() });
    }
});

app.get('/api/appointments/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('dashboard', 'agenda', 'billing', 'comissoes'), async (req, res) => {
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
            ORDER BY a.appointment_date DESC, a.appointment_time DESC, a.id DESC
        `, [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/appointments/booked/list', async (req, res) => {
    const barberId = Number(req.query.barberId);
    const professionalId = Number(req.query.professionalId);
    const date = String(req.query.date || '').slice(0, 10);
    if (!Number.isInteger(barberId) || barberId <= 0 || !Number.isInteger(professionalId) || professionalId <= 0 || !isValidDateValue(date)) {
        return res.status(400).json({ success: false, message: 'Informe uma barbearia, profissional e data válidos.' });
    }
    try {
        const professional = await pool.query(
            'SELECT id FROM professionals WHERE id = $1 AND barber_id = $2',
            [professionalId, barberId]
        );
        if (!professional.rows.length) {
            return res.status(400).json({ success: false, message: 'Profissional inválido para esta barbearia.' });
        }

        const result = await pool.query(`
            SELECT SUBSTRING(a.appointment_time::text, 1, 5) AS time,
                   COALESCE(s.duration, '30') AS duration
            FROM appointments a
            LEFT JOIN services s ON s.id = a.service_id
            WHERE a.barber_id = $1
              AND a.professional_id = $2
              AND a.appointment_date = $3
              AND a.status NOT IN ('canceled', 'no_show')
        `, [barberId, professionalId, date]);
        res.json(result.rows.map(row => ({ time: row.time, duration: row.duration })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Não foi possível consultar os horários.' });
    }
});

// Public lookup for clients: only completed appointments from the barber shop
// in the reservation link are returned, using a normalized WhatsApp number.
app.get('/api/public/appointments', async (req, res) => {
    const barberId = Number.parseInt(req.query.barberId, 10);
    const phone = String(req.query.phone || '').replace(/\D/g, '');

    if (!Number.isInteger(barberId) || barberId <= 0) {
        return res.status(400).json({ success: false, message: 'Barbearia inválida.' });
    }

    if (!/^\d{8,15}$/.test(phone)) {
        return res.status(400).json({ success: false, message: 'Informe um WhatsApp válido.' });
    }

    try {
        const result = await pool.query(`
            SELECT a.id,
                   TO_CHAR(a.appointment_date, 'DD/MM/YYYY') AS appointment_date_display,
                   SUBSTRING(a.appointment_time::text, 1, 5) AS appointment_time_display,
                   COALESCE(s.name, 'Serviço removido') AS service_name,
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
        res.status(500).json({ success: false, message: 'Não foi possível consultar os agendamentos.' });
    }
});

app.post('/api/appointments', async (req, res) => {
    const barberId = Number(req.body?.barberId);
    const serviceId = Number(req.body?.serviceId);
    const professionalId = Number(req.body?.professionalId);
    const clientName = String(req.body?.clientName || '').trim();
    const clientPhone = String(req.body?.clientPhone || '').trim();
    const time = String(req.body?.time || '').slice(0, 5);
    const date = String(req.body?.date || getBookingDateValue()).slice(0, 10);
    let db;
    try {
        await ensureOperationalSchema();
        await ensureAppointmentPaymentSchema();
        if (!Number.isInteger(barberId) || barberId <= 0 || !Number.isInteger(serviceId) || serviceId <= 0 || !Number.isInteger(professionalId) || professionalId <= 0) {
            return res.status(400).json({ success: false, message: 'Barbearia, serviço e profissional são obrigatórios.' });
        }
        if (clientName.length < 2 || clientName.length > 100 || !/^\d{8,15}$/.test(clientPhone.replace(/\D/g, ''))) {
            return res.status(400).json({ success: false, message: 'Informe nome e WhatsApp válidos.' });
        }
        if (!isValidDateValue(date) || !BOOKING_TIME_PATTERN.test(time)) {
            return res.status(400).json({ success: false, message: 'Informe data e horário válidos.' });
        }
        if (isBookingTimeInPast(date, time)) {
            return res.status(400).json({ success: false, message: 'Este horário já passou. Escolha outro horário.' });
        }

        const selection = await getBookingSelection(pool, barberId, serviceId, professionalId);
        if (!selection) {
            return res.status(400).json({ success: false, message: 'O serviço não está disponível para este profissional.' });
        }

        const durationMinutes = durationToMinutes(selection.duration);
        const bookingSettings = await fetchBookingSettings(barberId);
        const configuredTimes = getAvailableBookingTimes(bookingSettings, date, durationMinutes);

        if (isBookingTimeBlocked(bookingSettings, date, time, durationMinutes) || (!bookingSettings.allowCustomTime && !configuredTimes.includes(time))) {
            return res.status(400).json({ success: false, message: 'Este horário não está disponível para o serviço escolhido.' });
        }

        db = await pool.connect();
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${barberId}:${professionalId}:${date}`]);
        const collision = await findAppointmentConflict(db, {
            barberId,
            professionalId,
            appointmentDate: date,
            appointmentTime: time,
            durationMinutes
        });

        if (collision) {
            await db.query('ROLLBACK');
            return res.status(409).json({ success: false, message: 'Este horário se sobrepõe a outro atendimento deste profissional.' });
        }

        const result = await db.query(
            'INSERT INTO appointments (barber_id, service_id, professional_id, client_name, client_phone, appointment_time, appointment_date) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [barberId, serviceId, professionalId, clientName, clientPhone, time, date]
        );

        await db.query(`
            INSERT INTO clients (barber_id, name, phone)
            VALUES ($1, $2, $3)
            ON CONFLICT (barber_id, name, phone) DO NOTHING
        `, [barberId, clientName, clientPhone]);

        await db.query('COMMIT');

        res.json(result.rows[0]);
    } catch (err) {
        if (db) await db.query('ROLLBACK').catch(() => {});
        console.error(err);
        if (err.code === '23505') return res.status(409).json({ success: false, message: 'Este horário já foi reservado.' });
        res.status(500).json({ success: false, message: 'Não foi possível criar o agendamento.' });
    } finally {
        if (db) db.release();
    }
});

app.patch('/api/appointments/:id', authenticateToken, requireAppointmentMutationPermission, async (req, res) => {
    const { id } = req.params;
    const { status, paymentStatus, paymentMethod, serviceId, professionalId, clientName, clientPhone, time, date } = req.body;
    let db;
    try {
        await ensureOperationalSchema();
        await ensureAppointmentPaymentSchema();
        const hasAppointmentChanges = [serviceId, professionalId, clientName, clientPhone, time, date]
            .some(value => value !== undefined);
        const normalizedPaymentStatus = paymentStatus === 'pending' ? 'pending' : (paymentStatus === 'paid' ? 'paid' : null);
        const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);

        if (status && !APPOINTMENT_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: 'Status de atendimento invalido.' });
        }

        if (!hasAppointmentChanges) {
            const result = await pool.query(`
                UPDATE appointments
                SET status = COALESCE($1, status),
                    payment_status = COALESCE($2::varchar, payment_status),
                    payment_method = COALESCE($3, payment_method),
                    payment_paid_at = CASE
                        WHEN COALESCE($2::varchar, payment_status) = 'paid' THEN COALESCE(payment_paid_at, CURRENT_TIMESTAMP)
                        WHEN COALESCE($2::varchar, payment_status) = 'pending' THEN NULL
                        ELSE payment_paid_at
                    END
                WHERE id = $4 AND barber_id = $5
                RETURNING status, payment_status, payment_method
            `, [status || null, normalizedPaymentStatus, paymentMethod ? normalizedPaymentMethod : null, id, req.user.id]);
            if (!result.rows.length) {
                return res.status(404).json({ success: false, message: 'Agendamento não encontrado.' });
            }
            const updated = result.rows[0];
            await syncAppointmentCashMovement(pool, id, updated.status, updated.payment_status, updated.payment_method);
            await logAudit(req, 'appointment.status_updated', 'appointment', Number(id), {
                status: updated.status,
                paymentStatus: updated.payment_status,
                paymentMethod: updated.payment_method
            });
            return res.json({ success: true });
        }

        const normalizedServiceId = Number(serviceId);
        const normalizedProfessionalId = Number(professionalId);
        const normalizedName = String(clientName || '').trim();
        const normalizedPhone = String(clientPhone || '').trim();
        const normalizedTime = String(time || '').slice(0, 5);
        const normalizedDate = String(date || '').slice(0, 10);

        if (!Number.isInteger(normalizedServiceId) || normalizedServiceId <= 0
            || !Number.isInteger(normalizedProfessionalId) || normalizedProfessionalId <= 0
            || normalizedName.length < 2 || normalizedName.length > 100
            || !/^\d{8,15}$/.test(normalizedPhone.replace(/\D/g, ''))
            || !isValidDateValue(normalizedDate) || !BOOKING_TIME_PATTERN.test(normalizedTime)) {
            return res.status(400).json({ success: false, message: 'Preencha todos os dados do agendamento.' });
        }

        const selection = await getBookingSelection(pool, req.user.id, normalizedServiceId, normalizedProfessionalId);
        if (!selection) {
            return res.status(400).json({ success: false, message: 'O serviço não está disponível para este profissional.' });
        }

        const durationMinutes = durationToMinutes(selection.duration);
        const bookingSettings = await fetchBookingSettings(req.user.id);
        const configuredTimes = getAvailableBookingTimes(bookingSettings, normalizedDate, durationMinutes);
        if (isBookingTimeBlocked(bookingSettings, normalizedDate, normalizedTime, durationMinutes)
            || (!bookingSettings.allowCustomTime && !configuredTimes.includes(normalizedTime))) {
            return res.status(400).json({ success: false, message: 'Este horário não está disponível para o serviço escolhido.' });
        }

        db = await pool.connect();
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${req.user.id}:${normalizedProfessionalId}:${normalizedDate}`]);
        const collision = await findAppointmentConflict(db, {
            barberId: req.user.id,
            professionalId: normalizedProfessionalId,
            appointmentDate: normalizedDate,
            appointmentTime: normalizedTime,
            durationMinutes,
            excludeId: Number(id)
        });

        if (collision) {
            await db.query('ROLLBACK');
            return res.status(409).json({ success: false, message: 'Este horário se sobrepõe a outro atendimento deste profissional.' });
        }

        const result = await db.query(`
            UPDATE appointments
            SET service_id = $1, professional_id = $2, client_name = $3,
                client_phone = $4, appointment_time = $5, appointment_date = $6
            WHERE id = $7 AND barber_id = $8
            RETURNING *
        `, [normalizedServiceId, normalizedProfessionalId, normalizedName, normalizedPhone, normalizedTime, normalizedDate, id, req.user.id]);

        if (result.rows.length === 0) {
            await db.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Agendamento não encontrado.' });
        }

        await db.query(`
            INSERT INTO clients (barber_id, name, phone)
            SELECT barber_id, $1, $2 FROM appointments WHERE id = $3
            ON CONFLICT (barber_id, name, phone) DO NOTHING
        `, [normalizedName, normalizedPhone, id]);

        await db.query('COMMIT');

        await syncAppointmentCashMovement(pool, id, result.rows[0].status, result.rows[0].payment_status, result.rows[0].payment_method);
        await logAudit(req, 'appointment.updated', 'appointment', Number(id), { status: result.rows[0].status });
        res.json({ success: true, appointment: result.rows[0] });
    } catch (err) {
        console.error(err);
        if (db) await db.query('ROLLBACK').catch(() => {});
        res.status(500).json({ success: false, message: 'Não foi possível atualizar o agendamento.' });
    } finally {
        if (db) db.release();
    }
});

app.patch('/api/appointments/:id/payment', authenticateToken, requireAnyPermission('agenda', 'clientes'), async (req, res) => {
    const { id } = req.params;
    const paymentMethod = normalizePaymentMethod(req.body?.paymentMethod);
    try {
        await ensureOperationalSchema();
        await ensureAppointmentPaymentSchema();
        const result = await pool.query(`
            UPDATE appointments
            SET payment_status = 'paid', payment_method = $1, payment_paid_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND barber_id = $3 AND status = 'completed'
            RETURNING id, barber_id, payment_status, payment_method, payment_paid_at
        `, [paymentMethod, id, req.user.id]);

        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: 'Atendimento pendente não encontrado.' });
        }

        await syncAppointmentCashMovement(pool, id, 'completed', 'paid', paymentMethod);
        await logAudit(req, 'appointment.payment_received', 'appointment', Number(id), { paymentMethod });
        res.json({ success: true, appointment: result.rows[0] });
    } catch (err) {
        console.error('Erro ao confirmar pagamento do atendimento:', err);
        res.status(500).json({ success: false, message: 'Não foi possível confirmar o pagamento.' });
    }
});

app.patch('/api/appointments/:id/confirmation', authenticateToken, requireAnyPermission('dashboard', 'agenda'), async (req, res) => {
    const { id } = req.params;
    try {
        await ensureAppointmentPaymentSchema();
        const result = await pool.query(`
            UPDATE appointments
            SET confirmation_sent_at = CURRENT_TIMESTAMP,
                status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END
            WHERE id = $1 AND barber_id = $2
            RETURNING id, status, confirmation_sent_at
        `, [id, req.user.id]);

        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: 'Agendamento não encontrado.' });
        }

        res.json({ success: true, appointment: result.rows[0] });
    } catch (err) {
        console.error('Erro ao registrar confirmação do agendamento:', err);
        res.status(500).json({ success: false, message: 'Não foi possível salvar a confirmação.' });
    }
});

app.delete('/api/appointments/:id', authenticateToken, requireAnyPermission('agenda', 'clientes'), async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM appointments WHERE id = $1 AND barber_id = $2 RETURNING id', [id, req.user.id]);
        if (!result.rows.length) return res.status(404).json({ success: false, message: 'Agendamento nao encontrado.' });
        await removeCashMovement(pool, req.user.id, 'appointment', id);
        await logAudit(req, 'appointment.deleted', 'appointment', Number(id));
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/waitlist/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('agenda', 'clientes'), async (req, res) => {
    try {
        await ensureOperationalSchema();
        const result = await pool.query(`
            SELECT w.*, s.name AS service_name, p.name AS professional_name
            FROM waitlist_entries w
            LEFT JOIN services s ON s.id = w.service_id
            LEFT JOIN professionals p ON p.id = w.professional_id
            WHERE w.barber_id = $1 AND w.status NOT IN ('booked', 'canceled')
            ORDER BY w.desired_date NULLS LAST, w.created_at ASC
        `, [req.params.barberId]);
        res.json({ success: true, entries: result.rows });
    } catch (err) {
        console.error('Erro ao carregar fila de encaixe:', err);
        res.status(500).json({ success: false, message: 'Não foi possível carregar a fila de encaixe.' });
    }
});

app.post('/api/waitlist', authenticateToken, requireAnyPermission('agenda'), async (req, res) => {
    const clientName = String(req.body?.clientName || '').trim();
    const clientPhone = String(req.body?.clientPhone || '').replace(/\D/g, '');
    const serviceId = req.body?.serviceId ? Number(req.body.serviceId) : null;
    const professionalId = req.body?.professionalId ? Number(req.body.professionalId) : null;
    const desiredDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.desiredDate || '')) ? String(req.body.desiredDate) : null;
    const notes = String(req.body?.notes || '').trim().slice(0, 500) || null;
    if (clientName.length < 2 || !/^\d{8,15}$/.test(clientPhone)) return res.status(400).json({ success: false, message: 'Informe nome e WhatsApp válidos.' });
    try {
        await ensureOperationalSchema();
        if (serviceId) {
            const service = await pool.query('SELECT id FROM services WHERE id = $1 AND barber_id = $2', [serviceId, req.user.id]);
            if (!service.rows.length) return res.status(400).json({ success: false, message: 'Serviço inválido.' });
        }
        if (professionalId) {
            const professional = await pool.query('SELECT id FROM professionals WHERE id = $1 AND barber_id = $2', [professionalId, req.user.id]);
            if (!professional.rows.length) return res.status(400).json({ success: false, message: 'Barbeiro inválido.' });
        }
        if (serviceId && professionalId) {
            const assignment = await pool.query(
                'SELECT 1 FROM professional_services WHERE professional_id = $1 AND service_id = $2',
                [professionalId, serviceId]
            );
            if (!assignment.rows.length) return res.status(400).json({ success: false, message: 'O serviço não está disponível para este profissional.' });
        }
        const result = await pool.query(`
            INSERT INTO waitlist_entries (barber_id, client_name, client_phone, service_id, professional_id, desired_date, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
        `, [req.user.id, clientName, clientPhone, serviceId, professionalId, desiredDate, notes]);
        await logAudit(req, 'waitlist.created', 'waitlist_entry', result.rows[0].id, { clientName });
        res.status(201).json({ success: true, entry: result.rows[0] });
    } catch (err) {
        console.error('Erro ao cadastrar encaixe:', err);
        res.status(500).json({ success: false, message: 'Não foi possível cadastrar o encaixe.' });
    }
});

app.patch('/api/waitlist/:id', authenticateToken, requireAnyPermission('agenda'), async (req, res) => {
    const statuses = ['waiting', 'contacted', 'booked', 'canceled'];
    const status = String(req.body?.status || 'waiting');
    if (!statuses.includes(status)) return res.status(400).json({ success: false, message: 'Status inválido.' });
    try {
        await ensureOperationalSchema();
        const result = await pool.query('UPDATE waitlist_entries SET status = $1 WHERE id = $2 AND barber_id = $3 RETURNING *', [status, req.params.id, req.user.id]);
        if (!result.rows.length) return res.status(404).json({ success: false, message: 'Encaixe não encontrado.' });
        await logAudit(req, 'waitlist.updated', 'waitlist_entry', Number(req.params.id), { status });
        res.json({ success: true, entry: result.rows[0] });
    } catch (err) {
        console.error('Erro ao atualizar encaixe:', err);
        res.status(500).json({ success: false, message: 'Não foi possível atualizar o encaixe.' });
    }
});

app.get('/api/stats/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('dashboard', 'billing'), async (req, res) => {
    try {
        await ensureOperationalSchema();
        const barberId = Number(req.params.barberId);
        const currentDateValue = getBookingDateValue();
        const [currentYear, currentMonth, currentDay] = currentDateValue.split('-').map(Number);
        const year = Number(req.query.year) || currentYear;
        const month = Number(req.query.month) || currentMonth;
        const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const defaultDate = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(currentDay, monthDays)).padStart(2, '0')}`;
        const requestedDate = String(req.query.date || defaultDate).slice(0, 10);
        const requestedDateParts = requestedDate.split('-').map(Number);
        const normalizedRequestedDate = requestedDateParts.length === 3 && requestedDateParts.every(Number.isInteger)
            ? new Date(Date.UTC(requestedDateParts[0], requestedDateParts[1] - 1, requestedDateParts[2])).toISOString().slice(0, 10)
            : '';

        if (!Number.isInteger(barberId) || !Number.isInteger(year) || year < 2000 || !Number.isInteger(month) || month < 1 || month > 12 || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || normalizedRequestedDate !== requestedDate || requestedDate.slice(0, 7) !== `${year}-${String(month).padStart(2, '0')}`) {
            return res.status(400).json({ success: false, message: 'Período inválido.' });
        }

        const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
        const nextMonthStart = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);

        // Service revenue totals, plus the selected month and day.
        const svcResult = await pool.query(`
            SELECT
                COALESCE(SUM(CASE WHEN a.status = 'completed' THEN COALESCE(s.price, 0) ELSE 0 END), 0) AS revenue,
                COUNT(*) FILTER (WHERE a.status = 'completed') AS count,
                COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.appointment_date >= $2::date AND a.appointment_date < $3::date THEN COALESCE(s.price, 0) ELSE 0 END), 0) AS monthly_revenue,
                COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.appointment_date = $4::date THEN COALESCE(s.price, 0) ELSE 0 END), 0) AS daily_revenue
            FROM appointments a
            LEFT JOIN services s ON a.service_id = s.id
            WHERE a.barber_id = $1
        `, [barberId, monthStart, nextMonthStart, requestedDate]);

        // Product sales totals, plus the selected month and day.
        const salesResult = await pool.query(`
            SELECT
                COALESCE(SUM(total_price), 0) AS revenue,
                COALESCE(SUM(total_price) FILTER (WHERE sale_date >= $2::date AND sale_date < $3::date), 0) AS monthly_revenue,
                COALESCE(SUM(total_price) FILTER (WHERE sale_date::date = $4::date), 0) AS daily_revenue
            FROM sales
            WHERE barber_id = $1
        `, [barberId, monthStart, nextMonthStart, requestedDate]);

        const expensesResult = await pool.query(`
            SELECT
                COALESCE(SUM(amount) FILTER (WHERE expense_date >= $2::date AND expense_date < $3::date), 0) AS monthly_expenses,
                COALESCE(SUM(amount) FILTER (WHERE expense_date = $4::date), 0) AS daily_expenses
            FROM expenses
            WHERE barber_id = $1
        `, [barberId, monthStart, nextMonthStart, requestedDate]);

        const appointmentMetricsResult = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE appointment_date = $2::date AND status NOT IN ('canceled', 'no_show')) AS active_today,
                COUNT(*) FILTER (WHERE appointment_date = $2::date AND status = 'completed') AS completed_today,
                COUNT(*) FILTER (WHERE appointment_date = $2::date AND status = 'no_show') AS no_show_today,
                COUNT(*) FILTER (WHERE appointment_date = $2::date AND status = 'canceled') AS canceled_today,
                COUNT(*) FILTER (WHERE appointment_date >= $3::date AND appointment_date < $4::date AND status NOT IN ('canceled', 'no_show')) AS active_month,
                COUNT(*) FILTER (WHERE appointment_date >= $3::date AND appointment_date < $4::date AND status = 'no_show') AS no_show_month,
                COUNT(*) FILTER (WHERE appointment_date >= $3::date AND appointment_date < $4::date AND status = 'canceled') AS canceled_month,
                COUNT(*) FILTER (WHERE appointment_date >= $3::date AND appointment_date < $4::date AND status = 'completed') AS completed_month
            FROM appointments
            WHERE barber_id = $1
        `, [barberId, requestedDate, monthStart, nextMonthStart]);

        const clientMetricsResult = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE c.created_at >= $2::date AND c.created_at < $3::date) AS new_clients,
                COUNT(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM appointments a2
                    WHERE a2.barber_id = c.barber_id AND a2.client_phone = c.phone AND a2.status = 'completed'
                    GROUP BY a2.client_phone HAVING COUNT(*) > 1
                )) AS returning_clients
            FROM clients c
            WHERE c.barber_id = $1
        `, [barberId, monthStart, nextMonthStart]);

        const professionalRevenueResult = await pool.query(`
            SELECT p.id, p.name,
                   COALESCE(SUM(CASE WHEN a.status = 'completed' THEN COALESCE(s.price, 0) ELSE 0 END), 0) AS revenue,
                   COUNT(a.id) FILTER (WHERE a.status = 'completed') AS completed_count
            FROM professionals p
            LEFT JOIN appointments a ON a.professional_id = p.id AND a.barber_id = $1
                AND a.appointment_date >= $2::date AND a.appointment_date < $3::date
            LEFT JOIN services s ON s.id = a.service_id
            WHERE p.barber_id = $1
            GROUP BY p.id
            ORDER BY revenue DESC, p.name ASC
        `, [barberId, monthStart, nextMonthStart]);

        const serviceRev = parseFloat(svcResult.rows[0].revenue);
        const salesRev = parseFloat(salesResult.rows[0].revenue);
        const monthlyRevenue = parseFloat(svcResult.rows[0].monthly_revenue) + parseFloat(salesResult.rows[0].monthly_revenue);
        const dailyRevenue = parseFloat(svcResult.rows[0].daily_revenue) + parseFloat(salesResult.rows[0].daily_revenue);
        const appointmentMetrics = appointmentMetricsResult.rows[0] || {};
        const clientMetrics = clientMetricsResult.rows[0] || {};
        const completedMonth = Number(appointmentMetrics.completed_month || 0);

        res.json({
            revenue: serviceRev + salesRev,
            count: completedMonth,
            serviceRevenue: serviceRev,
            salesRevenue: salesRev,
            monthlyRevenue,
            dailyRevenue,
            monthlyExpenses: parseFloat(expensesResult.rows[0].monthly_expenses),
            dailyExpenses: parseFloat(expensesResult.rows[0].daily_expenses),
            monthlyProfit: monthlyRevenue - parseFloat(expensesResult.rows[0].monthly_expenses),
            activeToday: Number(appointmentMetrics.active_today || 0),
            activeMonth: Number(appointmentMetrics.active_month || 0),
            completedToday: Number(appointmentMetrics.completed_today || 0),
            noShowToday: Number(appointmentMetrics.no_show_today || 0),
            canceledToday: Number(appointmentMetrics.canceled_today || 0),
            noShowMonth: Number(appointmentMetrics.no_show_month || 0),
            canceledMonth: Number(appointmentMetrics.canceled_month || 0),
            averageTicket: completedMonth ? monthlyRevenue / completedMonth : 0,
            newClients: Number(clientMetrics.new_clients || 0),
            returningClients: Number(clientMetrics.returning_clients || 0),
            professionalRevenue: professionalRevenueResult.rows.map(row => ({
                id: row.id,
                name: row.name,
                revenue: Number(row.revenue || 0),
                completedCount: Number(row.completed_count || 0)
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// Cash register, reports and loyalty
app.get('/api/cash/register/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('billing', 'vendas', 'despesas'), async (req, res) => {
    const barberId = Number(req.params.barberId);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : getBookingDateValue();
    try {
        await ensureOperationalSchema();
        const register = await ensureCashRegister(pool, barberId, date);
        const movements = await pool.query(`
            SELECT id, source_type, source_id, payment_method, amount, description, movement_date, created_at
            FROM cash_movements WHERE barber_id = $1 AND movement_date = $2 ORDER BY created_at ASC, id ASC
        `, [barberId, date]);
        const summary = await pool.query(`
            SELECT COALESCE(SUM(amount), 0) AS total,
                   COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) AS inflow,
                   COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0) AS outflow,
                   COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0) AS cash_total,
                   COALESCE(SUM(amount) FILTER (WHERE payment_method = 'pix'), 0) AS pix_total,
                   COALESCE(SUM(amount) FILTER (WHERE payment_method = 'card'), 0) AS card_total
            FROM cash_movements WHERE barber_id = $1 AND movement_date = $2
        `, [barberId, date]);
        const row = summary.rows[0];
        res.json({ success: true, register, movements: movements.rows, summary: {
            total: Number(row.total || 0), inflow: Number(row.inflow || 0), outflow: Number(row.outflow || 0),
            cashTotal: Number(row.cash_total || 0), pixTotal: Number(row.pix_total || 0), cardTotal: Number(row.card_total || 0),
            expectedCash: Number(register.opening_balance || 0) + Number(row.cash_total || 0)
        }});
    } catch (err) {
        console.error('Erro ao carregar caixa:', err);
        res.status(500).json({ success: false, message: 'Nao foi possivel carregar o caixa.' });
    }
});

app.post('/api/cash/register/open', authenticateToken, requireAnyPermission('billing', 'vendas', 'despesas'), async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date || '')) ? String(req.body.date) : getBookingDateValue();
    const openingBalance = Number(String(req.body?.openingBalance ?? 0).replace(',', '.'));
    if (!Number.isFinite(openingBalance) || openingBalance < 0) return res.status(400).json({ success: false, message: 'Saldo inicial invalido.' });
    try {
        await ensureOperationalSchema();
        const register = await ensureCashRegister(pool, req.user.id, date, openingBalance);
        await logAudit(req, 'cash.opened', 'cash_register', register.id, { date, openingBalance });
        res.json({ success: true, register });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Nao foi possivel abrir o caixa.' });
    }
});

app.patch('/api/cash/register/:id/close', authenticateToken, requireAnyPermission('billing', 'vendas', 'despesas'), async (req, res) => {
    const closingBalance = Number(String(req.body?.closingBalance ?? '').replace(',', '.'));
    if (!Number.isFinite(closingBalance) || closingBalance < 0) return res.status(400).json({ success: false, message: 'Informe o saldo final contado.' });
    try {
        await ensureOperationalSchema();
        const result = await pool.query(`
            UPDATE cash_registers SET closing_balance = $1, status = 'closed', closed_at = CURRENT_TIMESTAMP, notes = $2
            WHERE id = $3 AND barber_id = $4 RETURNING *
        `, [closingBalance, String(req.body?.notes || '').trim() || null, req.params.id, req.user.id]);
        if (!result.rows.length) return res.status(404).json({ success: false, message: 'Caixa nao encontrado.' });
        await logAudit(req, 'cash.closed', 'cash_register', Number(req.params.id), { closingBalance });
        res.json({ success: true, register: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Nao foi possivel fechar o caixa.' });
    }
});

app.post('/api/cash/movements', authenticateToken, requireAnyPermission('billing', 'vendas', 'despesas'), async (req, res) => {
    const amount = Number(String(req.body?.amount ?? '').replace(',', '.'));
    const description = String(req.body?.description || '').trim();
    if (!Number.isFinite(amount) || amount === 0 || !description) return res.status(400).json({ success: false, message: 'Informe valor e descricao.' });
    try {
        await ensureOperationalSchema();
        await upsertCashMovement({ barberId: req.user.id, sourceType: 'adjustment', sourceId: null, amount, paymentMethod: req.body?.paymentMethod, description, movementDate: req.body?.date });
        res.status(201).json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Nao foi possivel registrar a movimentacao.' });
    }
});

app.get('/api/reports/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('relatorios'), async (req, res) => {
    const barberId = Number(req.params.barberId);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : getBookingMonthStart();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : getBookingDateValue();
    try {
        await ensureOperationalSchema();
        const [services, sales, expenses, commissions, topServices, topProducts] = await Promise.all([
            pool.query(`SELECT COALESCE(SUM(s.price),0) AS total, COUNT(a.id) AS count FROM appointments a LEFT JOIN services s ON s.id = a.service_id WHERE a.barber_id = $1 AND a.status = 'completed' AND a.appointment_date BETWEEN $2::date AND $3::date`, [barberId, from, to]),
            pool.query(`SELECT COALESCE(SUM(total_price),0) AS total, COUNT(id) AS count FROM sales WHERE barber_id = $1 AND sale_date::date BETWEEN $2::date AND $3::date`, [barberId, from, to]),
            pool.query(`SELECT category, COALESCE(SUM(amount),0) AS total FROM expenses WHERE barber_id = $1 AND expense_date BETWEEN $2::date AND $3::date GROUP BY category ORDER BY total DESC`, [barberId, from, to]),
            pool.query(`SELECT COALESCE(SUM(commission_value),0) AS total FROM sales WHERE barber_id = $1 AND sale_date::date BETWEEN $2::date AND $3::date`, [barberId, from, to]),
            pool.query(`SELECT COALESCE(s.name, 'Serviço removido') AS name, COUNT(a.id) AS count, COALESCE(SUM(s.price), 0) AS total FROM appointments a LEFT JOIN services s ON s.id = a.service_id WHERE a.barber_id = $1 AND a.status = 'completed' AND a.appointment_date BETWEEN $2::date AND $3::date GROUP BY s.name ORDER BY count DESC, total DESC LIMIT 10`, [barberId, from, to]),
            pool.query(`SELECT COALESCE(i.item_name, 'Produto removido') AS name, SUM(s.quantity) AS quantity, COALESCE(SUM(s.total_price), 0) AS total FROM sales s LEFT JOIN inventory i ON i.id = s.item_id WHERE s.barber_id = $1 AND s.sale_date::date BETWEEN $2::date AND $3::date GROUP BY i.item_name ORDER BY quantity DESC, total DESC LIMIT 10`, [barberId, from, to])
        ]);
        const serviceTotal = Number(services.rows[0].total || 0);
        const salesTotal = Number(sales.rows[0].total || 0);
        const expensesTotal = expenses.rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
        res.json({ success: true, period: { from, to }, summary: {
            serviceRevenue: serviceTotal, productRevenue: salesTotal, revenue: serviceTotal + salesTotal,
            expenses: expensesTotal, profit: serviceTotal + salesTotal - expensesTotal,
            commission: Number(commissions.rows[0].total || 0), serviceCount: Number(services.rows[0].count || 0), saleCount: Number(sales.rows[0].count || 0)
        }, expensesByCategory: expenses.rows, topServices: topServices.rows, topProducts: topProducts.rows });
    } catch (err) {
        console.error('Erro ao carregar relatorios:', err);
        res.status(500).json({ success: false, message: 'Não foi possível carregar os relatórios.' });
    }
});

app.get('/api/loyalty/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('clientes'), async (req, res) => {
    try {
        await ensureOperationalSchema();
        const result = await pool.query('SELECT id, name, phone, loyalty_points, referral_code FROM clients WHERE barber_id = $1 ORDER BY loyalty_points DESC, name ASC', [req.params.barberId]);
        res.json({ success: true, clients: result.rows });
    } catch (err) { res.status(500).json({ success: false, message: 'Nao foi possivel carregar a fidelidade.' }); }
});

app.post('/api/loyalty/adjust', authenticateToken, requireAnyPermission('clientes'), async (req, res) => {
    const clientId = Number(req.body?.clientId);
    const points = Number(req.body?.points);
    const reason = String(req.body?.reason || '').trim().slice(0, 160);
    if (!Number.isInteger(clientId) || !Number.isInteger(points) || points === 0 || !reason) return res.status(400).json({ success: false, message: 'Informe cliente, pontos e motivo.' });
    try {
        await ensureOperationalSchema();
        const db = await pool.connect();
        try {
            await db.query('BEGIN');
            const clientResult = await db.query('SELECT id, loyalty_points FROM clients WHERE id = $1 AND barber_id = $2 FOR UPDATE', [clientId, req.user.id]);
            if (!clientResult.rows.length) { await db.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Cliente nao encontrado.' }); }
            const next = Math.max(0, Number(clientResult.rows[0].loyalty_points || 0) + points);
            await db.query('UPDATE clients SET loyalty_points = $1 WHERE id = $2 AND barber_id = $3', [next, clientId, req.user.id]);
            await db.query('INSERT INTO loyalty_transactions (barber_id, client_id, points, reason) VALUES ($1, $2, $3, $4)', [req.user.id, clientId, points, reason]);
            await db.query('COMMIT');
            res.json({ success: true, points: next });
        } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { db.release(); }
    } catch (err) { console.error(err); res.status(500).json({ success: false, message: 'Nao foi possivel atualizar os pontos.' }); }
});

app.get('/api/monthly-goals/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('billing'), async (req, res) => {
    const barberId = Number(req.params.barberId);
    const [currentYear, currentMonth] = getBookingDateValue().split('-').map(Number);
    const year = Number(req.query.year) || currentYear;
    const month = Number(req.query.month) || currentMonth;

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
    const [currentYear, currentMonth] = getBookingDateValue().split('-').map(Number);
    const year = Number(req.body.year) || currentYear;
    const month = Number(req.body.month) || currentMonth;
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

// Expenses API
app.get('/api/expenses/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('despesas'), async (req, res) => {
    const barberId = Number(req.params.barberId);
    try {
        await ensureOperationalSchema();
        const result = await pool.query(`
            SELECT id, description, category, amount, expense_date, notes, payment_method, created_at
            FROM expenses
            WHERE barber_id = $1
            ORDER BY expense_date DESC, created_at DESC
        `, [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao carregar despesas:', err);
        res.status(500).json({ success: false, message: 'Não foi possível carregar as despesas.' });
    }
});

app.post('/api/expenses', authenticateToken, requireAnyPermission('despesas'), async (req, res) => {
    const barberId = Number(req.user.id);
    const description = String(req.body.description || '').trim();
    const category = String(req.body.category || 'Outros').trim() || 'Outros';
    const amount = Number(String(req.body.amount ?? '').replace(',', '.'));
    const expenseDate = String(req.body.expenseDate || '').slice(0, 10);
    const notes = String(req.body.notes || '').trim() || null;
    const paymentMethod = normalizePaymentMethod(req.body.paymentMethod);

    if (!description || description.length > 160 || !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) {
        return res.status(400).json({ success: false, message: 'Informe descrição, valor e data válidos para a despesa.' });
    }

    try {
        await ensureOperationalSchema();
        const result = await pool.query(`
            INSERT INTO expenses (barber_id, description, category, amount, expense_date, notes, payment_method)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, description, category, amount, expense_date, notes, payment_method, created_at
        `, [barberId, description, category.slice(0, 60), amount, expenseDate, notes, paymentMethod]);
        await ensureOperationalSchema();
        await upsertCashMovement({ barberId, sourceType: 'expense', sourceId: result.rows[0].id, amount: -amount, paymentMethod, description: `Despesa: ${description}`, movementDate: expenseDate });
        await logAudit(req, 'expense.created', 'expense', result.rows[0].id, { amount, category });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao lançar despesa:', err);
        res.status(500).json({ success: false, message: 'Não foi possível salvar a despesa.' });
    }
});

app.delete('/api/expenses/:id', authenticateToken, requireAnyPermission('despesas'), async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM expenses WHERE id = $1 AND barber_id = $2 RETURNING id',
            [Number(req.params.id), Number(req.user.id)]
        );
        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: 'Despesa não encontrada.' });
        }
        await ensureOperationalSchema();
        await removeCashMovement(pool, req.user.id, 'expense', result.rows[0].id);
        await logAudit(req, 'expense.deleted', 'expense', result.rows[0].id);
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao excluir despesa:', err);
        res.status(500).json({ success: false, message: 'Não foi possível excluir a despesa.' });
    }
});

// Clients API - Fixed last_service_date to use appointment_date for business logic
app.get('/api/clients/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('clientes'), async (req, res) => {
    try {
        await ensureOperationalSchema();
        await ensureAppointmentPaymentSchema();
        const { barberId } = req.params;
        const result = await pool.query(`
            SELECT c.*, 
                   MAX(a.appointment_date) FILTER (WHERE a.status = 'completed') as last_service_date,
                   (CURRENT_DATE - MAX(a.appointment_date) FILTER (WHERE a.status = 'completed')) as days_since_last_service,
                   COALESCE(SUM(CASE WHEN a.status = 'completed' THEN COALESCE(s.price, 0) ELSE 0 END), 0) as total_spent,
                   (SELECT s3.name FROM appointments a3 LEFT JOIN services s3 ON s3.id = a3.service_id WHERE a3.barber_id = c.barber_id AND a3.client_phone = c.phone AND a3.status = 'completed' GROUP BY s3.name ORDER BY COUNT(*) DESC, s3.name ASC LIMIT 1) as preferred_service,
                   (SELECT p3.name FROM appointments a4 LEFT JOIN professionals p3 ON p3.id = a4.professional_id WHERE a4.barber_id = c.barber_id AND a4.client_phone = c.phone AND a4.status = 'completed' GROUP BY p3.name ORDER BY COUNT(*) DESC, p3.name ASC LIMIT 1) as preferred_professional,
                   (SELECT a2.appointment_time 
                    FROM appointments a2 
                     WHERE a2.barber_id = c.barber_id AND a2.client_name = c.name AND a2.client_phone = c.phone AND a2.status = 'completed'
                    ORDER BY a2.appointment_date DESC, a2.appointment_time DESC LIMIT 1) as scheduled_time,
                   COUNT(a.id) as total_appointments,
                   COUNT(a.id) FILTER (WHERE a.status = 'completed' AND a.payment_status = 'pending') as pending_payment_count,
                   COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.payment_status = 'pending' THEN COALESCE(s.price, 0) ELSE 0 END), 0) as pending_payment_total
            FROM clients c
            LEFT JOIN appointments a ON c.barber_id = a.barber_id AND c.name = a.client_name AND c.phone = a.client_phone
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
        const clientResult = await pool.query('SELECT * FROM clients WHERE id = $1 AND barber_id = $2', [id, req.user.id]);
        const client = clientResult.rows[0];

        if (!client) return res.status(404).send('Client not found');

        const appointmentsResult = await pool.query(`
            SELECT a.*, COALESCE(s.name, 'Servi\u00E7o removido') as service_name,
                   COALESCE(s.price, 0) as service_price, p.name as professional_name
            FROM appointments a
            LEFT JOIN services s ON a.service_id = s.id
            LEFT JOIN professionals p ON a.professional_id = p.id
            WHERE a.barber_id = $3 AND a.client_name = $1 AND a.client_phone = $2
            ORDER BY a.appointment_date DESC, a.appointment_time DESC
        `, [client.name, client.phone, req.user.id]);

        const statsResult = await pool.query(`
            SELECT COALESCE(SUM(COALESCE(s.price, 0)), 0) as total_spent,
                   COUNT(a.id) as service_count,
                   COUNT(a.id) FILTER (WHERE a.status = 'completed' AND a.payment_status = 'pending') as pending_payment_count,
                   COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.payment_status = 'pending' THEN COALESCE(s.price, 0) ELSE 0 END), 0) as pending_payment_total
            FROM appointments a
            LEFT JOIN services s ON a.service_id = s.id
            WHERE a.barber_id = $3 AND a.client_name = $1 AND a.client_phone = $2 AND a.status = 'completed'
        `, [client.name, client.phone, req.user.id]);

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
        const clientRes = await pool.query('SELECT name, phone FROM clients WHERE id = $1 AND barber_id = $2', [id, req.user.id]);
        if (clientRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Cliente não encontrado' });
        
        const { name, phone } = clientRes.rows[0];
        db = await pool.connect();
        
        await db.query('BEGIN');
        // Delete associated appointments
        await db.query('DELETE FROM appointments WHERE barber_id = $3 AND client_name = $1 AND client_phone = $2', [name, phone, req.user.id]);

        // Keep sales history, but remove the reference to the deleted client.
        await db.query('UPDATE sales SET client_id = NULL WHERE client_id = $1 AND barber_id = $2', [id, req.user.id]);
        
        // Delete the client
        await db.query('DELETE FROM clients WHERE id = $1 AND barber_id = $2', [id, req.user.id]);
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
        await ensureOperationalSchema();
        const { barberId } = req.params;
        const result = await pool.query('SELECT * FROM services WHERE barber_id = $1 ORDER BY name ASC', [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/services', authenticateToken, requireAnyPermission('servicos'), async (req, res) => {
    const { name, price, duration, photoUrl, isPackage, packageSessions } = req.body;
    try {
        await ensureOperationalSchema();
        const result = await pool.query(
            'INSERT INTO services (barber_id, name, price, duration, photo_url, is_package, package_sessions) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [req.user.id, name, price, duration, photoUrl, Boolean(isPackage), isPackage ? (Number(packageSessions) || null) : null]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/services/:id', authenticateToken, requireAnyPermission('servicos'), async (req, res) => {
    const { id } = req.params;
    const { name, price, duration, photoUrl, isPackage, packageSessions } = req.body;
    try {
        await ensureOperationalSchema();
        await pool.query(
            'UPDATE services SET name = $1, price = $2, duration = $3, photo_url = $4, is_package = $5, package_sessions = $6 WHERE id = $7 AND barber_id = $8',
            [name, price, duration, photoUrl, Boolean(isPackage), isPackage ? (Number(packageSessions) || null) : null, id, req.user.id]
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
        await ensureOperationalSchema();
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
    const { name, phone, photoUrl, commission, productCommission } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO professionals (barber_id, name, phone, photo_url, commission, product_commission) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [req.user.id, name, phone, photoUrl, commission || 0, productCommission || 0]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/professional-services/:profId', async (req, res) => {
    try {
        await ensureOperationalSchema();
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
        const professional = await pool.query('SELECT id FROM professionals WHERE id = $1 AND barber_id = $2', [profId, req.user.id]);
        if (!professional.rows.length) return res.status(404).json({ success: false, message: 'Barbeiro nao encontrado.' });
        const ids = Array.isArray(serviceIds) ? serviceIds.map(Number).filter(Number.isInteger) : [];
        const services = ids.length ? await pool.query('SELECT id FROM services WHERE barber_id = $1 AND id = ANY($2::int[])', [req.user.id, ids]) : { rows: [] };
        await pool.query('DELETE FROM professional_services WHERE professional_id = $1', [profId]);
        if (services.rows.length > 0) {
            const placeholders = services.rows.map((_, index) => `($1, $${index + 2})`).join(',');
            await pool.query(`INSERT INTO professional_services (professional_id, service_id) VALUES ${placeholders}`, [profId, ...services.rows.map(row => row.id)]);
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
            'UPDATE professionals SET name = $1, phone = $2, photo_url = $3, commission = $4, product_commission = $5 WHERE id = $6 AND barber_id = $7',
            [name, phone, photoUrl, commission || 0, productCommission || 0, id, req.user.id]
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
        await pool.query('DELETE FROM professional_services WHERE professional_id = $1 AND professional_id IN (SELECT id FROM professionals WHERE barber_id = $2)', [id, req.user.id]);
        await pool.query('DELETE FROM professionals WHERE id = $1 AND barber_id = $2', [id, req.user.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/clients', authenticateToken, requireAnyPermission('clientes'), async (req, res) => {
    const { name, phone, notes, birthday, referralCode } = req.body;
    let db;
    try {
        await ensureOperationalSchema();
        db = await pool.connect();
        await db.query('BEGIN');
        const ownReferralCode = `BP-${req.user.id}-${Date.now().toString(36).toUpperCase()}`;
        const result = await db.query(
            'INSERT INTO clients (barber_id, name, phone, notes, birthday, referral_code) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [req.user.id, name, phone, notes, birthday || null, ownReferralCode]
        );
        const client = result.rows[0];
        if (referralCode) {
            const referrer = await db.query(
                'SELECT id FROM clients WHERE barber_id = $1 AND UPPER(referral_code) = UPPER($2) AND id <> $3 LIMIT 1',
                [req.user.id, String(referralCode).trim(), client.id]
            );
            if (referrer.rows.length) {
                const referral = await db.query(`
                    INSERT INTO referrals (barber_id, referrer_client_id, referred_client_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (barber_id, referred_client_id) DO NOTHING
                    RETURNING id, referrer_bonus, referred_bonus
                `, [req.user.id, referrer.rows[0].id, client.id]);
                if (referral.rows.length) {
                    const { id: referralId, referrer_bonus: referrerBonus, referred_bonus: referredBonus } = referral.rows[0];
                    await db.query('UPDATE clients SET loyalty_points = loyalty_points + $1 WHERE id = $2 AND barber_id = $3', [referrerBonus, referrer.rows[0].id, req.user.id]);
                    await db.query('UPDATE clients SET loyalty_points = loyalty_points + $1 WHERE id = $2 AND barber_id = $3', [referredBonus, client.id, req.user.id]);
                    await db.query(`
                        INSERT INTO loyalty_transactions (barber_id, client_id, points, reason, source_type, source_id)
                        VALUES ($1, $2, $3, 'Bônus por indicação', 'referral', $4), ($1, $5, $6, 'Bônus de indicação recebido', 'referral', $7)
                        ON CONFLICT (barber_id, source_type, source_id) DO NOTHING
                    `, [req.user.id, referrer.rows[0].id, referrerBonus, referralId, client.id, referredBonus, -referralId]);
                }
            }
        }
        await db.query('COMMIT');
        await logAudit(req, 'client.created', 'client', client.id, { referred: Boolean(referralCode) });
        res.json(client);
    } catch (err) {
        if (db) await db.query('ROLLBACK').catch(() => {});
        console.error(err);
        if (err.code === '23505') return res.status(409).json({ success: false, message: 'Já existe um cliente com estes dados.' });
        res.status(500).json({ success: false, message: 'Não foi possível cadastrar o cliente.' });
    } finally {
        if (db) db.release();
    }
});

// Inventory API (Revolutionary)
app.get('/api/inventory/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('estoque', 'vendas'), async (req, res) => {
    try {
        await ensureOperationalSchema();
        const { barberId } = req.params;
        const result = await pool.query('SELECT * FROM inventory WHERE barber_id = $1 ORDER BY item_name ASC', [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/inventory/item/:id/movements', authenticateToken, requireAnyPermission('estoque'), async (req, res) => {
    try {
        await ensureOperationalSchema();
        const result = await pool.query(`
            SELECT m.id, m.movement_type, m.quantity, m.unit_cost, m.reason, m.created_at, i.item_name
            FROM inventory_movements m JOIN inventory i ON i.id = m.inventory_id
            WHERE m.inventory_id = $1 AND m.barber_id = $2 ORDER BY m.created_at DESC LIMIT 100
        `, [req.params.id, req.user.id]);
        res.json({ success: true, movements: result.rows });
    } catch (err) { res.status(500).json({ success: false, message: 'Nao foi possivel carregar o historico do estoque.' }); }
});

app.post('/api/inventory', authenticateToken, requireAnyPermission('estoque'), async (req, res) => {
    const { itemName, description, photoUrl, supplier, costPrice, quantity, unit, minQuantity, unitPrice, generateCommission } = req.body;
    try {
        await ensureOperationalSchema();
        const result = await pool.query(
            'INSERT INTO inventory (barber_id, item_name, description, photo_url, supplier, cost_price, quantity, unit, min_quantity, unit_price, generate_commission) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
            [req.user.id, itemName, description, photoUrl, supplier || null, Number(costPrice) || 0, quantity, unit, minQuantity, unitPrice || 0, generateCommission !== false]
        );
        await recordInventoryMovement(pool, req.user.id, result.rows[0].id, 'entry', Number(quantity) || 0, Number(costPrice) || 0, 'Cadastro inicial');
        await logAudit(req, 'inventory.created', 'inventory', result.rows[0].id, { quantity });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/inventory/:id', authenticateToken, requireAnyPermission('estoque'), async (req, res) => {
    const { id } = req.params;
    const { itemName, description, photoUrl, supplier, costPrice, quantity, unit, minQuantity, unitPrice, generateCommission } = req.body;
    try {
        await ensureOperationalSchema();
        const currentResult = await pool.query('SELECT * FROM inventory WHERE id = $1 AND barber_id = $2', [id, req.user.id]);
        const current = currentResult.rows[0];
        if (!current) return res.status(404).json({ success: false, message: 'Produto nao encontrado.' });
        const result = await pool.query(
            `UPDATE inventory SET 
                item_name = COALESCE($1, item_name), 
                description = COALESCE($2, description),
                photo_url = COALESCE($3, photo_url),
                supplier = COALESCE($4, supplier),
                cost_price = COALESCE($5, cost_price),
                quantity = COALESCE($6, quantity),
                unit = COALESCE($7, unit),
                min_quantity = COALESCE($8, min_quantity),
                unit_price = COALESCE($9, unit_price),
                generate_commission = COALESCE($10, generate_commission)
            WHERE id = $11 AND barber_id = $12 RETURNING *`,
            [itemName, description, photoUrl, supplier, costPrice, quantity, unit, minQuantity, unitPrice, generateCommission, id, req.user.id]
        );
        const quantityDelta = Number(result.rows[0]?.quantity || 0) - Number(current.quantity || 0);
        if (quantityDelta) await recordInventoryMovement(pool, req.user.id, id, quantityDelta > 0 ? 'entry' : 'adjustment', quantityDelta, Number(costPrice ?? current.cost_price) || 0, 'Ajuste manual');
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/inventory/:id', authenticateToken, requireAnyPermission('estoque'), async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM inventory WHERE id = $1 AND barber_id = $2', [id, req.user.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// Sales API Endpoints
app.get('/api/sales/:barberId', authenticateToken, requireOwnBarber, requireAnyPermission('vendas', 'comissoes', 'billing'), async (req, res) => {
    const { barberId } = req.params;
    try {
        await ensureOperationalSchema();
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
    const { inventoryId, quantity, totalPrice, unitPrice, clientId, professionalId, paymentMethod, commissionRate: reqCommRate } = req.body;
    const barberId = req.user.id;
    
    if (!inventoryId || !quantity) return res.status(400).send('Dados incompletos');

    let client;
    try {
        await ensureOperationalSchema();
        client = await pool.connect();
        await client.query('BEGIN');

        const inventoryResult = await client.query(
            'SELECT generate_commission, cost_price, item_name FROM inventory WHERE id = $1 AND barber_id = $2 AND quantity >= $3 FOR UPDATE',
            [inventoryId, barberId, parseInt(quantity)]
        );

        if (inventoryResult.rowCount === 0) {
            throw new Error('Produto não encontrado ou estoque insuficiente');
        }

        const generatesCommission = inventoryResult.rows[0].generate_commission !== false;

        if (clientId) {
            const clientResult = await client.query('SELECT id FROM clients WHERE id = $1 AND barber_id = $2', [clientId, barberId]);
            if (!clientResult.rows.length) throw new Error('Cliente invalido');
        }
        if (professionalId) {
            const professionalResult = await client.query('SELECT id FROM professionals WHERE id = $1 AND barber_id = $2', [professionalId, barberId]);
            if (!professionalResult.rows.length) throw new Error('Barbeiro invalido');
        }
        
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
            'INSERT INTO sales (barber_id, item_id, client_id, professional_id, quantity, price_at_sale, total_price, commission_rate, commission_value, payment_method) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
            [barberId, inventoryId, clientId || null, professionalId || null, parseInt(quantity), parseFloat(unitPrice), parseFloat(totalPrice), commissionRate, commissionValue, normalizePaymentMethod(paymentMethod)]
        );

        // 2. Decrement inventory
        const invUpdate = await client.query(
            'UPDATE inventory SET quantity = quantity - $1 WHERE id = $2 AND barber_id = $3 RETURNING quantity',
            [parseInt(quantity), inventoryId, barberId]
        );

        if (invUpdate.rowCount === 0) {
            throw new Error('Produto não encontrado ou estoque insuficiente');
        }

        await recordInventoryMovement(client, barberId, inventoryId, 'sale', -parseInt(quantity), Number(inventoryResult.rows[0].cost_price) || 0, `Venda de ${inventoryResult.rows[0].item_name}`);
        await upsertCashMovement({ db: client, barberId, sourceType: 'sale', sourceId: saleResult.rows[0].id, amount: parseFloat(totalPrice), paymentMethod, description: `Venda de ${inventoryResult.rows[0].item_name}`, movementDate: getBookingDateValue() });

        await client.query('COMMIT');
        await logAudit(req, 'sale.created', 'sale', saleResult.rows[0].id, { totalPrice });
        res.json(saleResult.rows[0]);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).send(err.message || 'Server Error');
    } finally {
        if (client) client.release();
    }
});

app.delete('/api/sales/:id', authenticateToken, requireAnyPermission('vendas'), async (req, res) => {
    const { id } = req.params;
    let client;
    try {
        await ensureOperationalSchema();
        client = await pool.connect();
        await client.query('BEGIN');
        
        // 1. Get sale details to revert inventory
        const sale = await client.query('SELECT item_id, quantity, barber_id, total_price FROM sales WHERE id = $1 AND barber_id = $2', [id, req.user.id]);
        if (sale.rowCount > 0) {
            const { item_id, quantity, barber_id } = sale.rows[0];
            // 2. Revert inventory
            await client.query('UPDATE inventory SET quantity = quantity + $1 WHERE id = $2 AND barber_id = $3', [quantity, item_id, barber_id]);
            if (item_id) await recordInventoryMovement(client, barber_id, item_id, 'return', Number(quantity), 0, 'Estorno de venda');
            await removeCashMovement(client, barber_id, 'sale', id);
        } else {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Venda nao encontrada.' });
        }
        
        // 3. Delete sale
        await client.query('DELETE FROM sales WHERE id = $1 AND barber_id = $2', [id, req.user.id]);
        
        await client.query('COMMIT');
        await logAudit(req, 'sale.deleted', 'sale', Number(id));
        res.json({ success: true });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).send('Server Error');
    } finally {
        if (client) client.release();
    }
});

// Friendly public booking links for local/server deployments.
app.get('/:slug', async (req, res, next) => {
    const rawSlug = String(req.params.slug || '');
    if (!rawSlug || rawSlug.includes('.') || rawSlug === 'api') return next();

    const slug = slugifyBusinessName(rawSlug);
    if (!slug) return next();

    try {
        const result = await pool.query('SELECT shop_name FROM barbers');
        const exists = result.rows.some(row => slugifyBusinessName(row.shop_name) === slug);
        if (!exists) return next();
        res.sendFile(path.join(__dirname, '..', 'public', 'reserva.html'));
    } catch (err) {
        console.error('Erro ao abrir link público:', err);
        next();
    }
});


if (require.main === module) {
    app.listen(port, () => {
        console.log(`🚀 Gestano Server running on http://localhost:${port}`);
    });
}

module.exports = app;
