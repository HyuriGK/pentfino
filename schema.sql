/* 
  SQL Schema for Neon PostgreSQL - Pentfino
  Paste this into your Neon SQL Editor:
*/

CREATE TABLE IF NOT EXISTS barbers (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    shop_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS services (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER REFERENCES barbers(id),
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    duration VARCHAR(50) NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER REFERENCES barbers(id),
    service_id INTEGER REFERENCES services(id),
    client_name VARCHAR(100) NOT NULL,
    client_phone VARCHAR(20) NOT NULL,
    appointment_time TEXT NOT NULL,
    appointment_date DATE DEFAULT CURRENT_DATE,
    status VARCHAR(20) DEFAULT 'pending',
    professional_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS professionals (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER REFERENCES barbers(id),
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    photo_url TEXT,
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (barber_id, name, phone)
);

CREATE TABLE IF NOT EXISTS inventory (
    id SERIAL PRIMARY KEY,
    barber_id INTEGER REFERENCES barbers(id),
    item_name VARCHAR(100) NOT NULL,
    quantity INTEGER DEFAULT 0,
    unit VARCHAR(20) DEFAULT 'un',
    min_quantity INTEGER DEFAULT 5,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed Initial Data
INSERT INTO barbers (email, password, shop_name) 
VALUES ('demo@pentfino.com', 'demo123', 'Pentfino Luxury')
ON CONFLICT (email) DO NOTHING;

INSERT INTO services (barber_id, name, price, duration)
SELECT id, 'Corte de Cabelo', 50, '40 min' FROM barbers WHERE email = 'demo@pentfino.com'
UNION ALL
SELECT id, 'Barba Completa', 30, '20 min' FROM barbers WHERE email = 'demo@pentfino.com'
UNION ALL
SELECT id, 'Combo (Corte + Barba)', 70, '60 min' FROM barbers WHERE email = 'demo@pentfino.com';
