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
    status VARCHAR(20) DEFAULT 'pending',
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
