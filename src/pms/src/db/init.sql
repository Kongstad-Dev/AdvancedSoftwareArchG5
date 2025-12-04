-- PostgreSQL initialization script for PMS
-- Creates tables for orders, factory_assignments, and factories

-- Create orders table
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    order_id VARCHAR(50) UNIQUE NOT NULL,
    product_type VARCHAR(100) NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    deadline TIMESTAMP NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    priority INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create factories table
CREATE TABLE IF NOT EXISTS factories (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    capacity INTEGER NOT NULL DEFAULT 100,
    current_load INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'UP',
    last_heartbeat TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create factory_assignments table
CREATE TABLE IF NOT EXISTS factory_assignments (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    factory_id VARCHAR(50) REFERENCES factories(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    status VARCHAR(50) NOT NULL DEFAULT 'assigned',
    UNIQUE(order_id, factory_id)
);

-- Create production_events table for audit trail
CREATE TABLE IF NOT EXISTS production_events (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    factory_id VARCHAR(50) REFERENCES factories(id),
    order_id INTEGER REFERENCES orders(id),
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_deadline ON orders(deadline);
CREATE INDEX IF NOT EXISTS idx_factory_assignments_factory_id ON factory_assignments(factory_id);
CREATE INDEX IF NOT EXISTS idx_factory_assignments_status ON factory_assignments(status);
CREATE INDEX IF NOT EXISTS idx_production_events_factory_id ON production_events(factory_id);
CREATE INDEX IF NOT EXISTS idx_production_events_created_at ON production_events(created_at);

-- Insert default factories
INSERT INTO factories (id, name, capacity, status) VALUES
    ('factory-1', 'Factory Alpha', 100, 'UP'),
    ('factory-2', 'Factory Beta', 100, 'UP'),
    ('factory-3', 'Factory Gamma', 100, 'UP'),
    ('factory-4', 'Factory Delta', 100, 'UP')
ON CONFLICT (id) DO NOTHING;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
CREATE TRIGGER update_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_factories_updated_at ON factories;
CREATE TRIGGER update_factories_updated_at
    BEFORE UPDATE ON factories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
