const axios = require('axios')
const Groq = require('groq-sdk')
const fs = require('fs')
const path = require('path')
const supabase = require('./supabase')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function transcribeAudio(mediaId, businessId = null) {
  const tempPath = path.join('/tmp', `audio_${mediaId}.ogg`)
  
  try {
    const mediaResponse = await axios.get(
      `https://graph.facebook.com/v22.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    )
    const audioUrl = mediaResponse.data.url

    const audioResponse = await axios.get(audioUrl, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer'
    })

    fs.writeFileSync(tempPath, audioResponse.data)

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-large-v3-turbo',
      language: 'es'
    })

    supabase.from('transcriptions').insert({
      media_id: mediaId,
      business_id: businessId,
      text: transcription.text,
      model: 'whisper-large-v3-turbo',
      created_at: new Date().toISOString()
    }).catch(e => console.error('Error logging transcription:', e.message))

    return transcription.text

  } catch (err) {
    console.error('Error transcribiendo audio:', err.message)
    return null
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
}

module.exports = { transcribeAudio }