require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });
const express = require('express');
const cors = require('cors');
const { pool } = require('./base-datos');
const { crearBloqueOrigen, crearBloqueMovimiento, crearPrimerBloqueDesdeDistribucion, getUltimoBloque, getDueñoDesdeBloque, verificarCadena } = require('./blockchain');

// Flujo: Laboratorio GenCore → Operador Logístico → Distribuidor mayorista → Farmacia FarmaCo → Cliente
const NIVEL_A_ACTOR = {
  'laboratorio': 'laboratorio',
  'Laboratorio': 'laboratorio',
  'Laboratorio GenCore': 'laboratorio',
  'operador logístico': 'operador_logistico',
  'Operador logístico': 'operador_logistico',
  'Operador Logístico': 'operador_logistico',
  'operador_logistico': 'operador_logistico',
  'mayorista': 'mayorista',
  'Mayorista': 'mayorista',
  'Distribuidor mayorista': 'mayorista',
  'farmacia farmaco': 'farmacia_farmaco',
  'Farmacia FarmaCo': 'farmacia_farmaco',
  'Farmacia FarmaCo ': 'farmacia_farmaco',
  'farmacia_farmaco': 'farmacia_farmaco',
  'cliente': 'cliente',
  'Cliente': 'cliente',
};
function normalizarActor(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  return NIVEL_A_ACTOR[s] || s;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// POST /crear-medicamento
// Flujo: Laboratorio → formulario → backend guarda en DB → crea Bloque 1 (origen)
app.post('/crear-medicamento', async (req, res) => {
  const { id_medicamento, nombre, lote, fecha_fabricacion, fecha_vencimiento, imagen_url } = req.body || {};

  if (!id_medicamento || !nombre || !lote || !fecha_fabricacion || !fecha_vencimiento) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan datos: id_medicamento, nombre, lote, fecha_fabricacion, fecha_vencimiento son requeridos.',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insert = await client.query(
      `INSERT INTO medicamentos (id_medicamento, nombre, lote, fecha_fabricacion, fecha_vencimiento, imagen_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, id_medicamento, nombre, lote, fecha_fabricacion, fecha_vencimiento, imagen_url, creado_en`,
      [id_medicamento.trim(), nombre.trim(), lote.trim(), fecha_fabricacion, fecha_vencimiento, imagen_url && imagen_url.trim() || null]
    );
    const medicamento = insert.rows[0];

    const datosParaBloque = {
      id_medicamento: medicamento.id_medicamento,
      nombre: medicamento.nombre,
      lote: medicamento.lote,
      fecha_fabricacion: medicamento.fecha_fabricacion,
      fecha_vencimiento: medicamento.fecha_vencimiento,
    };

    const bloque = await crearBloqueOrigen(medicamento.id, datosParaBloque, client);
    await client.query('COMMIT');

    res.status(201).json({
      ok: true,
      medicamento: {
        id: medicamento.id,
        id_medicamento: medicamento.id_medicamento,
        nombre: medicamento.nombre,
        lote: medicamento.lote,
        fecha_fabricacion: medicamento.fecha_fabricacion,
        fecha_vencimiento: medicamento.fecha_vencimiento,
        imagen_url: medicamento.imagen_url || null,
        creado_en: medicamento.creado_en,
      },
      bloque_origen: {
        indice: bloque.indice,
        hash_anterior: bloque.hashAnterior,
        hash_bloque: bloque.hashBloque,
        mensaje: 'Bloque 1 creado: origen del medicamento en la blockchain.',
      },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') {
      return res.status(409).json({
        ok: false,
        error: 'Ya existe un medicamento con ese id_medicamento.',
      });
    }
    console.error('Error en /crear-medicamento:', e.message || e);
    if (e.code === '42P01') {
      return res.status(500).json({
        ok: false,
        error: 'Falta la tabla blockchain_bloques. Ejecuta el script db/init-db.sql en la base farmago.',
      });
    }
    res.status(500).json({ ok: false, error: 'Error al registrar el medicamento.', detalle: e.message });
  } finally {
    client.release();
  }
});

app.get('/health', (_, res) => {
  res.json({ ok: true, servicio: 'FarmaGo API' });
});

// GET /medicamentos - listar medicamentos desde la base de datos
app.get('/medicamentos', async (_, res) => {
  try {
    const r = await pool.query(
      `SELECT id, id_medicamento, nombre, lote, fecha_fabricacion, fecha_vencimiento, imagen_url, creado_en
       FROM medicamentos ORDER BY creado_en DESC`
    );
    res.json({ ok: true, medicamentos: r.rows });
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(500).json({
        ok: false,
        error: 'La tabla medicamentos no existe. Ejecuta db/init-db.sql en la base farmago.',
      });
    }
    console.error('Error en /medicamentos:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /registrar-movimiento
// Flujo: Distribuidor → formulario → backend valida dueño → nuevo bloque → guardado
app.post('/registrar-movimiento', async (req, res) => {
  const { id_medicamento, lote_id, tipo, nivel_actual, envio_a, fecha_movimiento } = req.body || {};
  const idOLote = (id_medicamento || lote_id || '').toString().trim();
  if (!idOLote || !tipo || !nivel_actual) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan datos: id_medicamento (o lote_id), tipo (Recibe/Envía), nivel_actual son requeridos.',
    });
  }
  const actorDestinoPagina = normalizarActor(nivel_actual);
  const actorDestinoEnvio = envio_a ? normalizarActor(envio_a) : null;
  let actorOrigen, actorDestino;
  if (tipo === 'Recibe') {
    actorDestino = actorDestinoPagina;
    actorOrigen = null; // se obtiene del último bloque
  } else if (tipo === 'Envía') {
    actorOrigen = actorDestinoPagina;
    actorDestino = actorDestinoEnvio;
    if (!actorDestino) {
      return res.status(400).json({
        ok: false,
        error: 'Para "Envía" debe indicar a quién envía (envio_a).',
      });
    }
  } else {
    return res.status(400).json({
      ok: false,
      error: 'tipo debe ser "Recibe" o "Envía".',
    });
  }

  const fechaMov = fecha_movimiento || new Date().toISOString().slice(0, 10);

  try {
    let medRow = await pool.query(
      `SELECT id FROM medicamentos WHERE id_medicamento = $1 OR lote = $1 LIMIT 1`,
      [idOLote]
    );

    // Si el medicamento no existe y es "Recibe", crearlo (mínimo) para poder confirmar la cadena
    if (!medRow.rows[0]) {
      if (tipo !== 'Recibe') {
        return res.status(404).json({
          ok: false,
          error: 'No existe un medicamento con ese id o lote. Para "Envía" el medicamento debe existir y estar en tu poder.',
        });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ins = await client.query(
          `INSERT INTO medicamentos (id_medicamento, nombre, lote, fecha_fabricacion, fecha_vencimiento)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [idOLote, 'Por confirmar', idOLote, fechaMov, fechaMov.slice(0, 4) + '-12-31']
        );
        const medicamentoId = ins.rows[0].id;
        const bloque = await crearPrimerBloqueDesdeDistribucion(medicamentoId, actorDestino, fechaMov, client);
        await client.query('COMMIT');
        return res.status(201).json({
          ok: true,
          movimiento: {
            origen: 'laboratorio',
            destino: actorDestino,
            fecha_movimiento: bloque.datos.fecha_movimiento,
          },
          bloque: {
            indice: bloque.indice,
            hash_anterior: bloque.hashAnterior,
            hash_bloque: bloque.hashBloque,
            mensaje: 'Medicamento registrado y primer bloque creado (laboratorio → ' + nivel_actual + '). Cadena confirmada.',
          },
        });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }

    const medicamentoId = medRow.rows[0].id;
    const ultimo = await getUltimoBloque(medicamentoId);

    // Si no hay bloques y es "Recibe", crear primer eslabón (laboratorio → este actor)
    if (!ultimo) {
      if (tipo !== 'Recibe') {
        return res.status(400).json({
          ok: false,
          error: 'Este medicamento no tiene movimientos aún. Solo puede registrar "Recibe" para iniciar la cadena.',
        });
      }
      const bloque = await crearPrimerBloqueDesdeDistribucion(medicamentoId, actorDestino, fechaMov);
      return res.status(201).json({
        ok: true,
        movimiento: {
          origen: 'laboratorio',
          destino: actorDestino,
          fecha_movimiento: bloque.datos.fecha_movimiento,
        },
        bloque: {
          indice: bloque.indice,
          hash_anterior: bloque.hashAnterior,
          hash_bloque: bloque.hashBloque,
          mensaje: 'Primer bloque creado (laboratorio → ' + nivel_actual + '). Cadena confirmada.',
        },
      });
    }

    const dueñoActual = getDueñoDesdeBloque(ultimo);

    // Código duplicado / ya vendido: si ya fue transferido al cliente, no se permiten más movimientos
    if (dueñoActual === 'cliente') {
      return res.status(400).json({
        ok: false,
        error: 'Medicamento ya transferido al cliente. No se pueden registrar más movimientos.',
        fraude: 'CODIGO_DUPLICADO',
      });
    }

    if (tipo === 'Recibe') {
      actorOrigen = dueñoActual;
      if (actorOrigen === actorDestino) {
        return res.status(400).json({
          ok: false,
          error: 'El medicamento ya está en poder de ' + nivel_actual + '. No puede "Recibe" de sí mismo.',
        });
      }
    } else {
      if (dueñoActual !== actorOrigen) {
        return res.status(400).json({
          ok: false,
          error: 'Actor no posee el medicamento. Dueño actual: ' + (dueñoActual || 'desconocido') + '.',
          fraude: 'TRANSFERENCIA_INVALIDA',
        });
      }
    }

    const bloque = await crearBloqueMovimiento(
      medicamentoId,
      actorOrigen,
      actorDestino,
      fechaMov
    );

    res.status(201).json({
      ok: true,
      movimiento: {
        origen: actorOrigen,
        destino: actorDestino,
        fecha_movimiento: bloque.datos.fecha_movimiento,
      },
      bloque: {
        indice: bloque.indice,
        hash_anterior: bloque.hashAnterior,
        hash_bloque: bloque.hashBloque,
        mensaje: 'Nuevo bloque de movimiento guardado.',
      },
    });
  } catch (e) {
    if (e.code === 'DUEÑO_INVALIDO' || e.code === 'ORIGEN_DESTINO_IGUAL') {
      return res.status(400).json({ ok: false, error: e.message });
    }
    console.error('Error en /registrar-movimiento:', e.message || e);
    res.status(500).json({ ok: false, error: e.message || 'Error al registrar el movimiento.' });
  }
});

// GET /historial/:id - Cliente consulta: backend busca todos los bloques y devuelve la cadena completa (+ detección fraude)
app.get('/historial/:id', async (req, res) => {
  const idOLote = (req.params.id && decodeURIComponent(req.params.id)) || (req.query.id_medicamento || '').toString().trim();
  if (!idOLote) {
    return res.status(400).json({
      ok: false,
      error: 'Indique el ID del medicamento (ej: GET /historial/MED-45-7 o ?id_medicamento=MED-45-7)',
      fraude: null,
    });
  }
  try {
    const medRow = await pool.query(
      `SELECT id, id_medicamento, nombre, lote, fecha_fabricacion, fecha_vencimiento, creado_en
       FROM medicamentos WHERE id_medicamento = $1 OR lote = $1 LIMIT 1`,
      [idOLote]
    );
    if (!medRow.rows[0]) {
      return res.status(404).json({
        ok: false,
        error: 'Medicamento no registrado.',
        fraude: 'MEDICAMENTO_INEXISTENTE',
        mensaje: 'El código no existe en el sistema. Posible falsificación.',
      });
    }
    const med = medRow.rows[0];
    const bloquesRow = await pool.query(
      `SELECT id, indice, hash_anterior, hash_bloque, datos, creado_en
       FROM blockchain_bloques WHERE id_medicamento_fk = $1 ORDER BY indice ASC`,
      [med.id]
    );
    const verificacion = await verificarCadena(med.id);
    const bloques = bloquesRow.rows.map((b) => {
      const datos = typeof b.datos === 'string' ? (() => { try { return JSON.parse(b.datos); } catch (e) { return {}; } })() : b.datos;
      return {
        id: b.id,
        indice: b.indice,
        origen: datos.origen || null,
        destino: datos.destino || null,
        fecha: datos.fecha_movimiento || datos.timestamp || b.creado_en,
        evento: datos.evento || null,
        hash_anterior: b.hash_anterior,
        hash_actual: b.hash_bloque,
        creado_en: b.creado_en,
      };
    });
    return res.json({
      ok: true,
      medicamento: {
        id_medicamento: med.id_medicamento,
        nombre: med.nombre,
        lote: med.lote,
        fecha_fabricacion: med.fecha_fabricacion,
        fecha_vencimiento: med.fecha_vencimiento,
      },
      historial: bloques,
      cadena_valida: verificacion.valida,
      fraude: verificacion.valida ? null : 'MANIPULACION_BLOCKCHAIN',
      mensaje_verificacion: verificacion.mensaje,
    });
  } catch (e) {
    console.error('Error en GET /historial:', e.message);
    res.status(500).json({ ok: false, error: e.message, fraude: null });
  }
});

// GET /medicamentos/disponibles-farmacia - medicamentos publicados por la Farmacia FarmaCo (cliente puede comprar)
app.get('/medicamentos/disponibles-farmacia', async (_, res) => {
  try {
    const r = await pool.query(`
      WITH ultimo_bloque AS (
        SELECT DISTINCT ON (id_medicamento_fk) id_medicamento_fk, datos
        FROM blockchain_bloques
        ORDER BY id_medicamento_fk, indice DESC
      )
      SELECT
        m.id,
        m.id_medicamento,
        m.nombre,
        m.lote,
        m.fecha_fabricacion,
        m.fecha_vencimiento,
        m.imagen_url,
        m.creado_en,
        inv.farmacia_id,
        inv.precio,
        inv.estado
      FROM medicamentos m
      INNER JOIN ultimo_bloque ub ON ub.id_medicamento_fk = m.id
      INNER JOIN inventario_farmacia inv ON inv.medicamento_id = m.id
      WHERE (ub.datos->>'destino' = 'farmacia_farmaco'
          OR (ub.datos->>'destino' IS NULL AND ub.datos->>'origen' = 'farmacia_farmaco'))
        AND inv.estado = 'disponible'
      ORDER BY inv.fecha_publicacion DESC, m.creado_en DESC
    `);
    res.json({
      ok: true,
      medicamentos: r.rows.map((m) => ({
        id: m.id,
        id_medicamento: m.id_medicamento,
        nombre: m.nombre,
        lote: m.lote,
        fecha_fabricacion: m.fecha_fabricacion,
        fecha_vencimiento: m.fecha_vencimiento,
        imagen_url: m.imagen_url,
        creado_en: m.creado_en,
        farmacia: m.farmacia_id || 'Farmacia FarmaCo',
        estado: m.estado || 'DISPONIBLE',
        precio: m.precio,
      })),
    });
  } catch (e) {
    console.error('Error en /medicamentos/disponibles-farmacia:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /farmacia/medicamentos-recibidos - medicamentos cuyo último dueño es Farmacia FarmaCo
app.get('/farmacia/medicamentos-recibidos', async (_, res) => {
  try {
    const r = await pool.query(`
      WITH ultimo_bloque AS (
        SELECT DISTINCT ON (id_medicamento_fk) id_medicamento_fk, datos
        FROM blockchain_bloques
        ORDER BY id_medicamento_fk, indice DESC
      )
      SELECT
        m.id,
        m.id_medicamento,
        m.nombre,
        m.lote,
        m.fecha_vencimiento,
        ub.datos,
        inv.estado AS estado_inventario,
        inv.precio
      FROM medicamentos m
      INNER JOIN ultimo_bloque ub ON ub.id_medicamento_fk = m.id
      LEFT JOIN inventario_farmacia inv ON inv.medicamento_id = m.id
      WHERE ub.datos->>'destino' = 'farmacia_farmaco'
         OR (ub.datos->>'destino' IS NULL AND ub.datos->>'origen' = 'farmacia_farmaco')
      ORDER BY m.creado_en DESC
    `);

    const lista = r.rows.map((row) => {
      let datos = row.datos;
      if (datos && typeof datos === 'string') {
        try { datos = JSON.parse(datos); } catch (e) { datos = {}; }
      }
      const origen = datos && (datos.origen || null);
      let estado = 'RECIBIDO';
      if (row.estado_inventario === 'disponible') estado = 'DISPONIBLE';
      if (row.estado_inventario === 'vendido') estado = 'VENDIDO';
      return {
        id: row.id,
        id_medicamento: row.id_medicamento,
        nombre: row.nombre,
        lote: row.lote,
        fecha_vencimiento: row.fecha_vencimiento,
        origen: origen,
        estado,
        precio: row.precio,
      };
    });

    res.json({ ok: true, medicamentos: lista });
  } catch (e) {
    console.error('Error en /farmacia/medicamentos-recibidos:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /farmacia/publicar-medicamento - la farmacia publica un medicamento en la tienda online
app.post('/farmacia/publicar-medicamento', async (req, res) => {
  const { id_medicamento, lote_id, precio, farmacia_id } = req.body || {};
  const idOLote = (id_medicamento || lote_id || '').toString().trim();
  if (!idOLote || !precio) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan datos: id_medicamento (o lote_id) y precio son requeridos.',
    });
  }
  const farmaciaId = (farmacia_id || 'farmacia_farmaco').toString().trim();

  try {
    const medRow = await pool.query(
      `SELECT id, id_medicamento, nombre, lote, fecha_fabricacion, fecha_vencimiento
       FROM medicamentos
       WHERE id_medicamento = $1 OR lote = $1
       LIMIT 1`,
      [idOLote]
    );
    if (!medRow.rows[0]) {
      return res.status(404).json({
        ok: false,
        error: 'No existe un medicamento con ese id o lote en la base de datos.',
      });
    }
    const med = medRow.rows[0];

    // Verificar que el último dueño sea la farmacia
    const bloquesRow = await pool.query(
      `SELECT datos
       FROM blockchain_bloques
       WHERE id_medicamento_fk = $1
       ORDER BY indice DESC
       LIMIT 1`,
      [med.id]
    );
    if (!bloquesRow.rows[0]) {
      return res.status(400).json({
        ok: false,
        error: 'El medicamento no tiene movimientos registrados aún. Debe llegar a Farmacia FarmaCo antes de publicarlo.',
      });
    }
    let datosUltimo = bloquesRow.rows[0].datos;
    if (datosUltimo && typeof datosUltimo === 'string') {
      try { datosUltimo = JSON.parse(datosUltimo); } catch (e) { datosUltimo = null; }
    }
    const dueñoActual = datosUltimo
      ? (datosUltimo.destino || datosUltimo.origen)
      : null;
    if (dueñoActual !== 'farmacia_farmaco') {
      return res.status(400).json({
        ok: false,
        error: 'Solo puede publicar medicamentos cuyo último movimiento termina en Farmacia FarmaCo.',
      });
    }

    const inv = await pool.query(
      `INSERT INTO inventario_farmacia (medicamento_id, farmacia_id, precio, estado, fecha_publicacion)
       VALUES ($1, $2, $3, 'disponible', NOW())
       ON CONFLICT (medicamento_id)
       DO UPDATE SET
         farmacia_id = EXCLUDED.farmacia_id,
         precio = EXCLUDED.precio,
         estado = 'disponible',
         fecha_publicacion = NOW()
       RETURNING id_inventario, medicamento_id, farmacia_id, precio, estado, fecha_publicacion`,
      [med.id, farmaciaId, precio]
    );

    return res.status(201).json({
      ok: true,
      mensaje: 'Medicamento publicado en FarmaGo online.',
      inventario: inv.rows[0],
      medicamento: {
        id_medicamento: med.id_medicamento,
        nombre: med.nombre,
        lote: med.lote,
        fecha_fabricacion: med.fecha_fabricacion,
        fecha_vencimiento: med.fecha_vencimiento,
      },
    });
  } catch (e) {
    console.error('Error en /farmacia/publicar-medicamento:', e.message || e);
    res.status(500).json({ ok: false, error: e.message || 'Error al publicar el medicamento.' });
  }
});

// POST /cliente/comprar - el cliente compra un medicamento disponible en la farmacia
app.post('/cliente/comprar', async (req, res) => {
  const { id_medicamento, lote_id, cliente_id } = req.body || {};
  const idOLote = (id_medicamento || lote_id || '').toString().trim();
  if (!idOLote) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan datos: id_medicamento (o lote_id) es requerido.',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const medRow = await client.query(
      `SELECT id, id_medicamento, nombre, lote, fecha_fabricacion, fecha_vencimiento
       FROM medicamentos
       WHERE id_medicamento = $1 OR lote = $1
       LIMIT 1`,
      [idOLote]
    );
    if (!medRow.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        ok: false,
        error: 'No existe un medicamento con ese id o lote.',
      });
    }
    const med = medRow.rows[0];

    // Verificar que esté publicado y disponible en inventario
    const invRow = await client.query(
      `SELECT id_inventario, farmacia_id, precio, estado
       FROM inventario_farmacia
       WHERE medicamento_id = $1
       LIMIT 1`,
      [med.id]
    );
    if (!invRow.rows[0] || invRow.rows[0].estado !== 'disponible') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        error: 'El medicamento no está disponible para la venta.',
      });
    }
    const inv = invRow.rows[0];

    // Verificar que el último dueño siga siendo la farmacia
    const bloquesRow = await client.query(
      `SELECT datos
       FROM blockchain_bloques
       WHERE id_medicamento_fk = $1
       ORDER BY indice DESC
       LIMIT 1`,
      [med.id]
    );
    if (!bloquesRow.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        error: 'El medicamento no tiene movimientos registrados aún.',
      });
    }
    let datosUltimo = bloquesRow.rows[0].datos;
    if (datosUltimo && typeof datosUltimo === 'string') {
      try { datosUltimo = JSON.parse(datosUltimo); } catch (e) { datosUltimo = null; }
    }
    const dueñoActual = datosUltimo
      ? (datosUltimo.destino || datosUltimo.origen)
      : null;
    if (dueñoActual === 'cliente') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        error: 'El medicamento ya fue vendido a un cliente.',
      });
    }
    if (dueñoActual !== 'farmacia_farmaco') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        error: 'El medicamento ya no está en poder de la farmacia.',
      });
    }

    // Crear último bloque: Farmacia → Cliente
    const fechaVenta = new Date().toISOString().slice(0, 10);
    const bloque = await crearBloqueMovimiento(
      med.id,
      'farmacia_farmaco',
      'cliente',
      fechaVenta
    );

    const precioVenta = inv.precio;
    const ventaRow = await client.query(
      `INSERT INTO ventas (medicamento_id, farmacia_id, cliente_id, fecha_venta, precio)
       VALUES ($1, $2, $3, NOW(), $4)
       RETURNING id_venta, fecha_venta`,
      [med.id, inv.farmacia_id, cliente_id || null, precioVenta]
    );

    await client.query(
      `UPDATE inventario_farmacia
       SET estado = 'vendido'
       WHERE id_inventario = $1`,
      [inv.id_inventario]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      mensaje: 'Compra registrada. El medicamento ha sido vendido.',
      venta: {
        id_venta: ventaRow.rows[0].id_venta,
        fecha_venta: ventaRow.rows[0].fecha_venta,
        precio: precioVenta,
      },
      bloque_final: {
        indice: bloque.indice,
        hash_anterior: bloque.hashAnterior,
        hash_bloque: bloque.hashBloque,
      },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error en /cliente/comprar:', e.message || e);
    res.status(500).json({ ok: false, error: e.message || 'Error al registrar la compra.' });
  } finally {
    client.release();
  }
});

// GET /medicamentos/verificar-cadena?id_medicamento=MED-XXX - verifica integridad (hash → cadena rota = fraude detectado)
app.get('/medicamentos/verificar-cadena', async (req, res) => {
  const idOLote = (req.query.id_medicamento || req.query.lote_id || '').toString().trim();
  if (!idOLote) {
    return res.status(400).json({ ok: false, error: 'Indique id_medicamento o lote_id (ej: ?id_medicamento=MED-45-7)' });
  }
  try {
    const medRow = await pool.query(
      `SELECT id FROM medicamentos WHERE id_medicamento = $1 OR lote = $1 LIMIT 1`,
      [idOLote]
    );
    if (!medRow.rows[0]) {
      return res.json({ ok: true, encontrado: false, valida: false, mensaje: 'No existe un medicamento con ese id o lote.' });
    }
    const resultado = await verificarCadena(medRow.rows[0].id);
    return res.json({
      ok: true,
      encontrado: true,
      valida: resultado.valida,
      bloque_invalido: resultado.bloqueInvalido,
      mensaje: resultado.mensaje,
    });
  } catch (e) {
    console.error('Error en /medicamentos/verificar-cadena:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /medicamentos/trazabilidad?id_medicamento=MED-XXX - ver estado y dueño actual (para depurar)
app.get('/medicamentos/trazabilidad', async (req, res) => {
  const idOLote = (req.query.id_medicamento || req.query.lote_id || '').toString().trim();
  if (!idOLote) {
    return res.status(400).json({ ok: false, error: 'Indique id_medicamento o lote_id en la URL (ej: ?id_medicamento=MED-45-7)' });
  }
  try {
    const medRow = await pool.query(
      `SELECT id, id_medicamento, nombre, lote FROM medicamentos WHERE id_medicamento = $1 OR lote = $1 LIMIT 1`,
      [idOLote]
    );
    if (!medRow.rows[0]) {
      return res.json({
        ok: true,
        encontrado: false,
        mensaje: 'No existe un medicamento con ese id o lote. Créalo primero en la página del Laboratorio.',
      });
    }
    const med = medRow.rows[0];
    const bloquesRow = await pool.query(
      `SELECT indice, hash_bloque, datos, creado_en FROM blockchain_bloques WHERE id_medicamento_fk = $1 ORDER BY indice ASC`,
      [med.id]
    );
    const bloques = bloquesRow.rows;
    const ultimo = bloques.length ? bloques[bloques.length - 1] : null;
    let datosUltimo = ultimo && ultimo.datos;
    if (datosUltimo && typeof datosUltimo === 'string') {
      try { datosUltimo = JSON.parse(datosUltimo); } catch (e) { datosUltimo = null; }
    }
    const dueñoActual = ultimo && datosUltimo
      ? (datosUltimo.destino || datosUltimo.origen)
      : null;
    return res.json({
      ok: true,
      encontrado: true,
      medicamento: { id_medicamento: med.id_medicamento, nombre: med.nombre, lote: med.lote },
      cantidad_bloques: bloques.length,
      dueño_actual: dueñoActual || (bloques.length ? 'desconocido' : null),
      mensaje: !bloques.length
        ? 'Este medicamento no tiene bloque de origen. Regístralo primero desde el Laboratorio (Ingresar medicamento).'
        : 'Puedes registrar "Recibe" en Distribución si tu nivel no es el dueño actual.',
      bloques: bloques.map((b) => ({
        indice: b.indice,
        datos: typeof b.datos === 'string' ? b.datos : b.datos,
        creado_en: b.creado_en,
      })),
    });
  } catch (e) {
    console.error('Error en /medicamentos/trazabilidad:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /bloques - listar bloques de la blockchain (para verificar que se guardan)
app.get('/bloques', async (_, res) => {
  try {
    const r = await pool.query(
      `SELECT b.id, b.id_medicamento_fk, b.indice, b.hash_anterior, b.hash_bloque, b.datos, b.creado_en
       FROM blockchain_bloques b ORDER BY b.creado_en DESC LIMIT 50`
    );
    res.json({ ok: true, bloques: r.rows });
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(500).json({
        ok: false,
        error: 'La tabla blockchain_bloques no existe. Ejecuta db/init-db.sql en la base farmago.',
      });
    }
    console.error('Error en /bloques:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

(async () => {
  try {
    await pool.query('SELECT 1');
    app.listen(PORT, () => {
      console.log(`FarmaGo API escuchando en http://localhost:${PORT}`);
    });
  } catch (e) {
    console.error('No se pudo conectar a la base de datos. Revisa DATABASE_URL y que las tablas existan (carpeta db).', e.message);
    process.exit(1);
  }
})();
