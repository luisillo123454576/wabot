async function analyzePaymentProof(mediaId) {
  return {
    es_comprobante: true,
    monto: null,
    entidad: null,
    fecha: null,
    estado: 'dudoso',
    confianza: 'baja'
  }
}

module.exports = { analyzePaymentProof }