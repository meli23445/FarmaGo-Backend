-- FarmaGo: medicamentos y trazabilidad (PostgreSQL)
-- Ejecutar contra tu base PostgreSQL (ej: psql $DATABASE_URL -f backend/db/init-db.sql)

CREATE TABLE IF NOT EXISTS medicamentos (
  id SERIAL PRIMARY KEY,
  id_medicamento VARCHAR(100) UNIQUE NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  lote VARCHAR(100) NOT NULL,
  fecha_fabricacion DATE NOT NULL,
  fecha_vencimiento DATE NOT NULL,
  imagen_url VARCHAR(500),
  creado_en TIMESTAMPTZ DEFAULT NOW()
);

-- Si la tabla ya existía sin imagen_url, añadir la columna
ALTER TABLE medicamentos ADD COLUMN IF NOT EXISTS imagen_url VARCHAR(500);

CREATE TABLE IF NOT EXISTS blockchain_bloques (
  id SERIAL PRIMARY KEY,
  id_medicamento_fk INTEGER REFERENCES medicamentos(id) ON DELETE CASCADE,
  indice INTEGER NOT NULL,
  hash_anterior VARCHAR(64) NOT NULL,
  hash_bloque VARCHAR(64) NOT NULL,
  datos JSONB NOT NULL,
  creado_en TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(id_medicamento_fk, indice)
);

CREATE INDEX IF NOT EXISTS idx_medicamentos_id ON medicamentos(id_medicamento);
CREATE INDEX IF NOT EXISTS idx_bloques_medicamento ON blockchain_bloques(id_medicamento_fk);

-- Inventario en farmacia: qué medicamentos ha publicado la farmacia en la tienda
CREATE TABLE IF NOT EXISTS inventario_farmacia (
  id_inventario SERIAL PRIMARY KEY,
  medicamento_id INTEGER NOT NULL REFERENCES medicamentos(id) ON DELETE CASCADE,
  farmacia_id VARCHAR(100) NOT NULL,
  precio NUMERIC(12,2) NOT NULL,
  estado VARCHAR(20) NOT NULL,
  fecha_publicacion TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (medicamento_id)
);

-- Asegurar que las columnas existan si la tabla ya estaba creada
ALTER TABLE inventario_farmacia
  ADD COLUMN IF NOT EXISTS farmacia_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS precio NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS estado VARCHAR(20),
  ADD COLUMN IF NOT EXISTS fecha_publicacion TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_inventario_medicamento ON inventario_farmacia(medicamento_id);
CREATE INDEX IF NOT EXISTS idx_inventario_estado ON inventario_farmacia(estado);

-- Ventas registradas por la farmacia cuando el cliente compra
CREATE TABLE IF NOT EXISTS ventas (
  id_venta SERIAL PRIMARY KEY,
  medicamento_id INTEGER NOT NULL REFERENCES medicamentos(id) ON DELETE CASCADE,
  farmacia_id VARCHAR(100) NOT NULL,
  cliente_id VARCHAR(100),
  fecha_venta TIMESTAMPTZ DEFAULT NOW(),
  precio NUMERIC(12,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ventas_medicamento ON ventas(medicamento_id);
CREATE INDEX IF NOT EXISTS idx_ventas_farmacia ON ventas(farmacia_id);

