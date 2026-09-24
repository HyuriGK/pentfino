/* 
  SQL Schema for Neon PostgreSQL - BarberPoint
  Paste this into your Neon SQL Editor:
*/

CREATE TABLE IF NOT EXISTS barbers (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    shop_name VARCHAR(255) NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monthly_goals (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    goal_year INTEGER NOT NULL,
    goal_month INTEGER NOT NULL CHECK (goal_month BETWEEN 1 AND 12),
    amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (barber_id, goal_year, goal_month)
);

CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    description VARCHAR(160) NOT NULL,
    category VARCHAR(60) NOT NULL DEFAULT 'Outros',
    amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    notes TEXT,
    payment_method VARCHAR(20) NOT NULL DEFAULT 'cash',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS barber_settings (
    barber_id INTEGER PRIMARY KEY REFERENCES barbers(id) ON DELETE CASCADE,
    booking_style VARCHAR(30) NOT NULL DEFAULT 'classic',
    schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
    allow_custom_time BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS services (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER REFERENCES barbers(id),
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    duration VARCHAR(50) NOT NULL,
    photo_url TEXT,
    is_package BOOLEAN NOT NULL DEFAULT FALSE,
    package_sessions INTEGER
);

CREATE TABLE IF NOT EXISTS appointments (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER REFERENCES barbers(id),
    service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
    client_name VARCHAR(100) NOT NULL,
    client_phone VARCHAR(20) NOT NULL,
    appointment_time TEXT NOT NULL,
    appointment_date DATE DEFAULT CURRENT_DATE,
    status VARCHAR(20) DEFAULT 'pending',
    payment_status VARCHAR(20) NOT NULL DEFAULT 'paid',
    payment_method VARCHAR(20) NOT NULL DEFAULT 'cash',
    payment_paid_at TIMESTAMP,
    confirmation_sent_at TIMESTAMP,
    professional_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS professionals (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER REFERENCES barbers(id),
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    photo_url TEXT,
    commission DECIMAL(5,2) DEFAULT 0,
    product_commission DECIMAL(5,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS professional_services (
    professional_id INTEGER REFERENCES professionals(id) ON DELETE CASCADE,
    service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
    PRIMARY KEY (professional_id, service_id)
);

CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER REFERENCES barbers(id),
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    notes TEXT,
    birthday DATE,
    loyalty_points INTEGER NOT NULL DEFAULT 0,
    referral_code VARCHAR(40),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (barber_id, name, phone)
);

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
);

CREATE INDEX IF NOT EXISTS marketing_leads_created_at_idx ON marketing_leads (created_at DESC);

CREATE TABLE IF NOT EXISTS inventory (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER REFERENCES barbers(id),
    item_name VARCHAR(100) NOT NULL,
    supplier VARCHAR(160),
    cost_price DECIMAL(10,2) NOT NULL DEFAULT 0,
    quantity INTEGER DEFAULT 0,
    unit VARCHAR(20) DEFAULT 'un',
    min_quantity INTEGER DEFAULT 5,
    generate_commission BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER REFERENCES barbers(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    professional_id INTEGER REFERENCES professionals(id) ON DELETE SET NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    price_at_sale DECIMAL(10,2) NOT NULL DEFAULT 0,
    total_price DECIMAL(10,2) NOT NULL CHECK (total_price >= 0),
    commission_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    commission_value DECIMAL(10,2) NOT NULL DEFAULT 0,
    payment_method VARCHAR(20) NOT NULL DEFAULT 'cash',
    sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS booking_blocks (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    block_date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    reason VARCHAR(160),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK ((start_time IS NULL AND end_time IS NULL) OR (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time))
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

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'cash';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'cash';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'cash';
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

CREATE INDEX IF NOT EXISTS appointments_barber_date_idx ON appointments (barber_id, appointment_date, appointment_time);
CREATE INDEX IF NOT EXISTS waitlist_entries_barber_status_idx ON waitlist_entries (barber_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS cash_movements_barber_date_idx ON cash_movements (barber_id, movement_date);
CREATE INDEX IF NOT EXISTS inventory_movements_item_idx ON inventory_movements (inventory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_barber_date_idx ON audit_logs (barber_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_transactions_source_idx ON loyalty_transactions (barber_id, source_type, source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS referrals_barber_idx ON referrals (barber_id, created_at DESC);

ALTER TABLE barbers ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE barbers ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE barbers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
-- Seed Initial Data
INSERT INTO barbers (email, password, shop_name, is_admin)
VALUES (
    'brasil.hyuri@gmail.com',
    '$2b$10$ZXI327CmozKhoq54XaBFYeROX3ZYM8cfk98Oo4dTDzLgmsR9V46lm',
    'Painel BarberPoint',
    TRUE
)
ON CONFLICT (email) DO UPDATE
SET password = EXCLUDED.password,
    shop_name = EXCLUDED.shop_name,
    is_admin = TRUE;

INSERT INTO barbers (email, password, shop_name, is_admin)
VALUES ('demo@barberpoint.com', 'demo123', 'BarberPoint Demo', FALSE)
ON CONFLICT (email) DO NOTHING;

INSERT INTO services (barber_id, name, price, duration)
SELECT id, 'Corte Clássico', 50, '40 min' FROM barbers WHERE email = 'demo@barberpoint.com'
UNION ALL
SELECT id, 'Barba Completa', 30, '20 min' FROM barbers WHERE email = 'demo@barberpoint.com'
UNION ALL
SELECT id, 'Pacote Estilo', 70, '60 min' FROM barbers WHERE email = 'demo@barberpoint.com';
