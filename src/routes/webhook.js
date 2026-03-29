const { Router } = require('express')
const router = Router()

router.get('/', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verificado')
    res.status(200).send(challenge)
  } else {
    res.status(403).send('Forbidden')
  }
})

router.post('/', (req, res) => {
  const body = req.body
  console.log('Mensaje recibido:', JSON.stringify(body, null, 2))
  res.status(200).send('OK')
})

module.exports = router