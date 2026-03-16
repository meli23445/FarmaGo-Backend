const CryptoJS = require('crypto-js');
const { pool } = require('./base-datos');

const GENESIS_PREVIOUS = '0';

/**
 * Calcula el hash SHA256 de un bloque (hashAnterior + datos + timestamp).
 */
function hashBlock(previousHash, data, timestamp) {
  const payload = previousHash + JSON.stringify(data) + timestamp;
  return CryptoJS.SHA256(payload).toString(CryptoJS.enc.Hex);
}

/**
 * Crea el Bloque 1 (origen) para un medicamento recién registrado.
 * Bloque 1 = primer eslabón de la cadena de trazabilidad.
 * @param {number} medicamentoId - ID del registro en medicamentos
 * @param {object} datosMedicamento - { id_medicamento, nombre, lote, fecha_fabricacion, fecha_vencimiento }
 * @param {object} [client] - Cliente pg opcional (para usar en la misma transacción)
 */
async function crearBloqueOrigen(medicamentoId, datosMedicamento, client) {
  const indice = 1;
  const previousHash = GENESIS_PREVIOUS;
  const timestamp = new Date().toISOString();
  const datos = {
    evento: 'fabricacion',
    origen: 'laboratorio',
    id_medicamento: datosMedicamento.id_medicamento,
    nombre: datosMedicamento.nombre,
    lote: datosMedicamento.lote,
    fecha_fabricacion: datosMedicamento.fecha_fabricacion,
    fecha_vencimiento: datosMedicamento.fecha_vencimiento,
    timestamp,
  };
  const hashBloque = hashBlock(previousHash, datos, timestamp);

  const db = client || await pool.connect();
  const release = !client;
  try {
    await db.query(
      `INSERT INTO blockchain_bloques (id_medicamento_fk, indice, hash_anterior, hash_bloque, datos)
       VALUES ($1, $2, $3, $4, $5)`,
      [medicamentoId, indice, previousHash, hashBloque, JSON.stringify(datos)]
    );
    return { indice, hashAnterior: previousHash, hashBloque, datos };
  } finally {
    if (release) db.release();
  }
}

/**
 * Obtiene el último bloque de la cadena de un medicamento.
 */
async function getUltimoBloque(medicamentoId, client) {
  const db = client || await pool.connect();
  const release = !client;
  try {
    const r = await db.query(
      `SELECT id, indice, hash_bloque, datos FROM blockchain_bloques
       WHERE id_medicamento_fk = $1 ORDER BY indice DESC LIMIT 1`,
      [medicamentoId]
    );
    return r.rows[0] || null;
  } finally {
    if (release) db.release();
  }
}

/**
 * Devuelve quién posee actualmente el medicamento (origen del último bloque o destino si es movimiento).
 */
function getDueñoDesdeBloque(ultimoBloque) {
  if (!ultimoBloque) return null;
  let d = ultimoBloque.datos;
  if (!d) return null;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (e) { return null; }
  }
  if (d.destino) return d.destino;
  return d.origen || null;
}

/**
 * Crea un nuevo bloque de movimiento (cambio de actor).
 * @param {number} medicamentoId - ID en tabla medicamentos
 * @param {string} actorOrigen - Quién entrega (debe ser el dueño actual)
 * @param {string} actorDestino - Quién recibe
 * @param {string} fechaMovimiento - Fecha del movimiento (YYYY-MM-DD)
 * @param {object} [client] - Cliente pg para transacción
 */
async function crearBloqueMovimiento(medicamentoId, actorOrigen, actorDestino, fechaMovimiento, client) {
  const ultimo = await getUltimoBloque(medicamentoId, client);
  if (!ultimo) throw new Error('No existe bloque previo para este medicamento.');
  const dueñoActual = getDueñoDesdeBloque(ultimo);
  if (dueñoActual !== actorOrigen) {
    const err = new Error('El medicamento no está en poder de ' + actorOrigen + '. Dueño actual: ' + (dueñoActual || 'desconocido') + '.');
    err.code = 'DUEÑO_INVALIDO';
    throw err;
  }
  if (actorOrigen === actorDestino) {
    const err = new Error('Origen y destino no pueden ser el mismo.');
    err.code = 'ORIGEN_DESTINO_IGUAL';
    throw err;
  }

  const indice = ultimo.indice + 1;
  const previousHash = ultimo.hash_bloque;
  const timestamp = new Date().toISOString();
  const datos = {
    evento: 'movimiento',
    origen: actorOrigen,
    destino: actorDestino,
    fecha_movimiento: fechaMovimiento,
    timestamp,
  };
  const hashBloque = hashBlock(previousHash, datos, timestamp);

  const db = client || await pool.connect();
  const release = !client;
  try {
    await db.query(
      `INSERT INTO blockchain_bloques (id_medicamento_fk, indice, hash_anterior, hash_bloque, datos)
       VALUES ($1, $2, $3, $4, $5)`,
      [medicamentoId, indice, previousHash, hashBloque, JSON.stringify(datos)]
    );
    return { indice, hashAnterior: previousHash, hashBloque, datos };
  } finally {
    if (release) db.release();
  }
}

/**
 * Crea el primer bloque desde distribución (laboratorio → actorDestino).
 * Permite confirmar la cadena cuando el medicamento existe pero no tiene bloques,
 * o cuando se registra por primera vez desde un distribuidor.
 */
async function crearPrimerBloqueDesdeDistribucion(medicamentoId, actorDestino, fechaMovimiento, client) {
  const indice = 1;
  const previousHash = GENESIS_PREVIOUS;
  const timestamp = new Date().toISOString();
  const datos = {
    evento: 'movimiento',
    origen: 'laboratorio',
    destino: actorDestino,
    fecha_movimiento: fechaMovimiento || new Date().toISOString().slice(0, 10),
    timestamp,
  };
  const hashBloque = hashBlock(previousHash, datos, timestamp);

  const db = client || await pool.connect();
  const release = !client;
  try {
    await db.query(
      `INSERT INTO blockchain_bloques (id_medicamento_fk, indice, hash_anterior, hash_bloque, datos)
       VALUES ($1, $2, $3, $4, $5)`,
      [medicamentoId, indice, previousHash, hashBloque, JSON.stringify(datos)]
    );
    return { indice, hashAnterior: previousHash, hashBloque, datos };
  } finally {
    if (release) db.release();
  }
}

/**
 * Verifica la integridad de la cadena de bloques de un medicamento.
 * Si algún bloque fue modificado: hash cambia → cadena rota → fraude detectado.
 * @returns { valid: boolean, bloqueInvalido: number|null, mensaje: string }
 */
async function verificarCadena(medicamentoId) {
  const bloquesRow = await pool.query(
    `SELECT id, indice, hash_anterior, hash_bloque, datos, creado_en
     FROM blockchain_bloques WHERE id_medicamento_fk = $1 ORDER BY indice ASC`,
    [medicamentoId]
  );
  const bloques = bloquesRow.rows;
  if (!bloques.length) {
    return { valida: false, bloqueInvalido: null, mensaje: 'No hay bloques para este medicamento.' };
  }
  let hashPrevioEsperado = GENESIS_PREVIOUS;
  for (let i = 0; i < bloques.length; i++) {
    const b = bloques[i];
    if (b.hash_anterior !== hashPrevioEsperado) {
      return {
        valida: false,
        bloqueInvalido: b.indice,
        mensaje: 'Cadena rota: el hash_anterior del bloque ' + b.indice + ' no coincide con el bloque anterior. Posible fraude.',
      };
    }
    let datos = b.datos;
    if (typeof datos === 'string') {
      try { datos = JSON.parse(datos); } catch (e) { datos = {}; }
    }
    const timestamp = (datos && datos.timestamp) || (b.creado_en ? new Date(b.creado_en).toISOString() : '');
    const hashCalculado = hashBlock(b.hash_anterior, datos, timestamp);
    if (hashCalculado !== b.hash_bloque) {
      return {
        valida: false,
        bloqueInvalido: b.indice,
        mensaje: 'Cadena rota: el hash del bloque ' + b.indice + ' no coincide. Los datos fueron alterados. Fraude detectado.',
      };
    }
    hashPrevioEsperado = b.hash_bloque;
  }
  return {
    valida: true,
    bloqueInvalido: null,
    mensaje: 'Cadena íntegra. Ningún bloque ha sido modificado.',
  };
}

module.exports = {
  hashBlock,
  crearBloqueOrigen,
  getUltimoBloque,
  getDueñoDesdeBloque,
  crearBloqueMovimiento,
  crearPrimerBloqueDesdeDistribucion,
  verificarCadena,
  GENESIS_PREVIOUS,
};
