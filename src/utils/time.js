function getBusinessTime(timezone = 'America/Bogota') {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short'
  })

  const parts = formatter.formatToParts(now)
  const get = type => parts.find(p => p.type === type)?.value

  const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  const dayOfWeek = dayMap[get('weekday')]
  const hour = parseInt(get('hour'))
  const minute = parseInt(get('minute'))
  const currentMinutes = hour * 60 + minute

  return { dayOfWeek, currentMinutes, hour, minute }
}

function isBusinessOpen(business) {
  if (!business.open_time || !business.close_time || !business.open_days) return true

  const { dayOfWeek, currentMinutes } = getBusinessTime(business.timezone || 'America/Bogota')

  const [openH, openM] = business.open_time.split(':').map(Number)
  const [closeH, closeM] = business.close_time.split(':').map(Number)
  const openMinutes = openH * 60 + openM
  const closeMinutes = closeH * 60 + closeM

  const dayOpen = business.open_days.includes(dayOfWeek)
  const timeOpen = currentMinutes >= openMinutes && currentMinutes < closeMinutes

  return dayOpen && timeOpen
}

module.exports = { getBusinessTime, isBusinessOpen }