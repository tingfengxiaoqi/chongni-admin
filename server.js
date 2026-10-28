const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { URL } = require('url')

const ROOT = __dirname
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
const PORT = config.port || 8789
const dbPath = path.join(ROOT, 'data', 'db.json')
const publicDir = path.join(ROOT, 'public')
const uploadDir = path.join(ROOT, 'uploads')
const adminSessions = new Set()
fs.mkdirSync(uploadDir, { recursive: true })
const smsCodes = new Map()
const userSessions = new Map()

const ORDER_STATUS = {
  pending: '待发货',
  shipping: '配送中',
  done: '已完成',
  cancelled: '已取消'
}
const PAY_STATUS = {
  unpaid: '待支付',
  paid: '已支付',
  refunded: '已退款'
}
const CATS = ['主粮', '零食', '用品', '玩具', '健康', '清洁']

function uid(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex')
}

function nowText() {
  const d = new Date()
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

function today() {
  return nowText().slice(0, 10)
}

function loadCatalog() {
  const candidates = [
    path.join(ROOT, 'seed', 'catalog.js'),
    path.join(ROOT, '../chongni/data/catalog.js')
  ]
  for (const file of candidates) {
    try {
      return require(file)
    } catch (e) {
      // try next
    }
  }
  return { goods: [], hospitals: [], shops: [], posts: [] }
}

function seedDb() {
  const catalog = loadCatalog()
  const goods = (catalog.goods || []).map((item) => ({
    id: item.id,
    name: item.name,
    sold: item.sold || '0',
    price: Number(item.price) || 0,
    cat: item.cat || '用品',
    icon: item.icon || '🛒',
    stock: 99,
    onSale: true,
    desc: item.desc || '',
    thumb: '',
    images: [],
    intro: item.intro || (item.name + '\n\n精选宠物好物，适合日常喂养与护理。')
  }))
  const places = {
    hospitals: (catalog.hospitals || []).map((p, i) => Object.assign({ id: 'h' + (i + 1) }, p)),
    shops: (catalog.shops || []).map((p, i) => Object.assign({ id: 's' + (i + 1) }, p))
  }
  const posts = (catalog.posts || []).map((p, i) => Object.assign({}, p, {
    userId: '',
    likedBy: [],
    commentList: [],
    comments: Number(p.comments) || 0,
    createdAt: nowText(),
    status: 'published',
    // 种子动态错开一点时间，便于相对时间展示
    _seedHours: (i + 1) * 5
  })).map((p) => {
    const d = new Date(Date.now() - (p._seedHours || 1) * 3600 * 1000)
    const pad = (n) => (n < 10 ? '0' + n : '' + n)
    p.createdAt = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes())
    delete p._seedHours
    return p
  })
  return {
    users: [],
    pets: [],
    reminders: [],
    expenses: [],
    cases: [],
    posts,
    friendships: [],
    chatMessages: [],
    goods,
    orders: [],
    places
  }
}

function ensureDbShape(db) {
  const fresh = seedDb()
  Object.keys(fresh).forEach((key) => {
    if (db[key] === undefined) db[key] = fresh[key]
  })
  if (!db.places || typeof db.places !== 'object') db.places = fresh.places
  db.places.hospitals = Array.isArray(db.places.hospitals) ? db.places.hospitals : fresh.places.hospitals
  db.places.shops = Array.isArray(db.places.shops) ? db.places.shops : fresh.places.shops
  db.goods = ensureGoodsFields(Array.isArray(db.goods) ? db.goods : fresh.goods)
  return db
}

function loadDb() {
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const fresh = seedDb()
    fs.writeFileSync(dbPath, JSON.stringify(fresh, null, 2))
    return fresh
  }
  const db = ensureDbShape(JSON.parse(fs.readFileSync(dbPath, 'utf8')))
  return db
}

function saveDb(db) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2))
}

function cookies(req) {
  const out = {}
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const index = part.indexOf('=')
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  })
  return out
}

function isAdmin(req) {
  const token = cookies(req).chongni_admin
  return Boolean(token && adminSessions.has(token))
}

function getBearer(req) {
  const auth = String(req.headers.authorization || '')
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return String(req.headers['x-session-token'] || '').trim()
}

function getUser(req) {
  const token = getBearer(req)
  if (!token) return null
  const session = userSessions.get(token)
  if (!session) return null
  if (session.expireAt < Date.now()) {
    userSessions.delete(token)
    return null
  }
  const db = loadDb()
  const user = db.users.find((u) => u.id === session.userId)
  if (!user) return null
  if ((user.status || 'active') === 'banned') {
    userSessions.delete(token)
    return null
  }
  return { token, user, db }
}

function publicUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    nickname: user.nickname,
    city: user.city,
    avatar: user.avatar || '🐾',
    joinedAt: user.joinedAt,
    openid: user.openid ? 'bound' : '',
    status: user.status || 'active'
  }
}

function revokeUserSessions(userId) {
  for (const [token, session] of userSessions.entries()) {
    if (session.userId === userId) userSessions.delete(token)
  }
}

function buildDashboard(db) {
  const paidOrders = db.orders.filter((o) => o.payStatus === 'paid')
  const revenue = paidOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0)
  const unpaid = db.orders.filter((o) => o.payStatus === 'unpaid').length
  const pendingShip = db.orders.filter((o) => o.payStatus === 'paid' && o.status === 'pending').length
  const lowStock = db.goods.filter((g) => g.onSale && Number(g.stock) <= 5)
  const todayKey = today()
  const todayOrders = db.orders.filter((o) => String(o.createdAt || '').startsWith(todayKey)).length
  const todayPosts = db.posts.filter((p) => String(p.createdAt || '').startsWith(todayKey)).length
  const banned = db.users.filter((u) => u.status === 'banned').length
  return {
    users: db.users.length,
    banned,
    pets: db.pets.length,
    goodsOnSale: db.goods.filter((g) => g.onSale).length,
    goodsTotal: db.goods.length,
    lowStock: lowStock.length,
    orders: db.orders.length,
    pending: db.orders.filter((o) => o.status === 'pending').length,
    pendingShip,
    unpaid,
    revenue: Math.round(revenue * 100) / 100,
    posts: db.posts.filter((p) => p.status !== 'hidden').length,
    hiddenPosts: db.posts.filter((p) => p.status === 'hidden').length,
    friendships: db.friendships.length,
    chatMessages: db.chatMessages.length,
    todayOrders,
    todayPosts,
    payMode: config.payMode || 'sandbox',
    smsMode: (config.sms && config.sms.mode) || 'dev',
    mapProvider: config.mapProvider || 'amap',
    mapReady: (function () {
      const p = String(config.mapProvider || 'amap').toLowerCase()
      if (p === 'qq' || p === 'tencent') return Boolean(config.qqMapKey)
      if (p === 'baidu') return Boolean(config.baiduAk)
      return Boolean(config.amapKey)
    })(),
    recentOrders: db.orders.slice().reverse().slice(0, 6),
    recentPosts: db.posts.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 6),
    lowStockGoods: lowStock.slice(0, 8).map((g) => ({
      id: g.id, name: g.name, icon: g.icon, stock: g.stock, price: g.price
    }))
  }
}

function send(res, status, body, extra) {
  const headers = Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization, x-session-token',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  }, extra || {})
  res.writeHead(status, headers)
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req, limit) {
  const raw = (await readBody(req, limit || 500000)).toString() || '{}'
  try {
    return JSON.parse(raw)
  } catch (e) {
    return {}
  }
}

function serveFile(res, filePath, type) {
  if (!fs.existsSync(filePath)) {
    send(res, 404, { error: '找不到文件' })
    return
  }
  res.writeHead(200, { 'content-type': type })
  fs.createReadStream(filePath).pipe(res)
}

function httpJson(urlStr, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: (options && options.method) || 'GET',
      headers: (options && options.headers) || {}
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        try {
          resolve(JSON.parse(text))
        } catch (e) {
          resolve({ raw: text })
        }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function code2Session(jsCode) {
  const appId = config.wx && config.wx.appId
  const secret = config.wx && config.wx.appSecret
  if (!appId || !secret || !jsCode) return null
  const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' +
    encodeURIComponent(appId) + '&secret=' + encodeURIComponent(secret) +
    '&js_code=' + encodeURIComponent(jsCode) + '&grant_type=authorization_code'
  const data = await httpJson(url)
  if (!data || !data.openid) return null
  return data
}

function issueSession(userId) {
  const token = crypto.randomBytes(24).toString('hex')
  userSessions.set(token, {
    userId,
    expireAt: Date.now() + 30 * 24 * 3600 * 1000
  })
  return token
}

function createSmsCode(phone) {
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const ttl = ((config.sms && config.sms.codeTtlSec) || 300) * 1000
  smsCodes.set(phone, { code, expireAt: Date.now() + ttl })
  const mode = (config.sms && config.sms.mode) || 'dev'
  if (mode === 'dev') {
    console.log('[SMS][dev]', phone, code)
  } else if (mode === 'http' && config.sms.webhook) {
    httpJson(config.sms.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    }, JSON.stringify({ phone, code })).catch(() => {})
  }
  return code
}

function verifySmsCode(phone, code) {
  const fixed = config.sms && config.sms.devFixedCode
  if (fixed && String(code) === String(fixed)) return true
  const row = smsCodes.get(phone)
  if (!row) return false
  if (row.expireAt < Date.now()) {
    smsCodes.delete(phone)
    return false
  }
  if (String(row.code) !== String(code)) return false
  smsCodes.delete(phone)
  return true
}

function normalizeCityName(value) {
  let city = value
  if (Array.isArray(city)) city = city[0] || ''
  city = String(city || '').trim()
  if (!city || city === '[]') return ''
  return city.replace(/市$/, '')
}

function findOrCreateUser(db, phone, patch) {
  let user = db.users.find((u) => u.phone === phone)
  if (!user) {
    const city = patch && patch.city ? normalizeCityName(patch.city) : ''
    user = {
      id: uid('u'),
      phone,
      nickname: '铲屎官' + phone.slice(-4),
      city: city || '',
      avatar: '🐾',
      joinedAt: today(),
      openid: '',
      status: 'active',
      createdAt: nowText()
    }
    db.users.push(user)
    if (patch) {
      const rest = Object.assign({}, patch)
      delete rest.city
      Object.assign(user, rest)
    }
  } else {
    if (!user.status) user.status = 'active'
    if (patch) {
      const next = Object.assign({}, patch)
      if (next.city !== undefined) {
        const city = normalizeCityName(next.city)
        // 仅在尚未设置城市时用定位结果填充，避免覆盖用户手动修改
        if (city && !normalizeCityName(user.city)) user.city = city
        delete next.city
      }
      Object.assign(user, next)
    }
  }
  return user
}

function normalizeMediaUrl(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.indexOf('data:image/') === 0) return text.slice(0, 900000)
  if (/^https?:\/\//i.test(text) || text.indexOf('/uploads/') === 0) return text.slice(0, 2000)
  return text.slice(0, 2000)
}

function normalizeGoods(body, id) {
  const name = String(body.name || '').trim()
  const price = Number(body.price)
  if (!name || !(price >= 0)) return null
  let images = []
  if (Array.isArray(body.images)) {
    images = body.images.map(normalizeMediaUrl).filter(Boolean).slice(0, 9)
  } else if (typeof body.images === 'string' && body.images.trim()) {
    images = body.images.split(/\n+/).map(normalizeMediaUrl).filter(Boolean).slice(0, 9)
  }
  const thumb = normalizeMediaUrl(body.thumb) || images[0] || ''
  return {
    id: id || String(body.id || uid('g')),
    name,
    sold: String(body.sold || '0'),
    price,
    cat: CATS.indexOf(body.cat) >= 0 ? body.cat : '用品',
    icon: String(body.icon || '🛒').slice(0, 4) || '🛒',
    stock: Math.max(0, Number(body.stock) || 0),
    onSale: body.onSale !== false && body.onSale !== 'false',
    desc: String(body.desc || '').slice(0, 200),
    thumb,
    images,
    intro: String(body.intro || '').slice(0, 20000)
  }
}

function ensureGoodsFields(goods) {
  return (goods || []).map((g) => Object.assign({
    desc: '',
    thumb: '',
    images: [],
    intro: ''
  }, g, {
    images: Array.isArray(g.images) ? g.images : [],
    thumb: g.thumb || '',
    intro: g.intro || '',
    desc: g.desc || ''
  }))
}

function userPets(db, userId) {
  return db.pets.filter((p) => p.userId === userId)
}

function friendIdsOf(db, userId) {
  const ids = []
  db.friendships.forEach((f) => {
    if (f.userA === userId) ids.push(f.userB)
    if (f.userB === userId) ids.push(f.userA)
  })
  return ids
}

function buildFriendList(db, userId) {
  return friendIdsOf(db, userId).map((fid) => {
    const user = db.users.find((u) => u.id === fid)
    if (!user) return null
    const pets = userPets(db, fid)
    const petName = pets[0] ? pets[0].name : '毛孩子'
    const last = db.chatMessages
      .filter((m) => (m.fromUserId === userId && m.toUserId === fid) || (m.fromUserId === fid && m.toUserId === userId))
      .slice(-1)[0]
    const unread = db.chatMessages.filter((m) => m.fromUserId === fid && m.toUserId === userId && !m.read).length
    return {
      id: user.id,
      name: user.nickname,
      avatar: user.avatar || '🐾',
      detail: (user.city || '') + ' · ' + petName,
      phone: user.phone,
      preview: last ? ((last.fromUserId === userId ? '我：' : '') + last.text) : (user.city || ''),
      unread,
      lastTime: last ? last.time : ''
    }
  }).filter(Boolean)
}

function inbox(db, userId) {
  const friends = buildFriendList(db, userId)
  return friends
    .filter((f) => f.preview)
    .map((f) => ({
      id: 'inbox_' + f.id,
      friendId: f.id,
      from: f.name,
      text: f.preview.replace(/^我：/, ''),
      unread: f.unread > 0,
      avatar: f.avatar,
      time: f.lastTime,
      system: false
    }))
    .sort((a, b) => String(b.time).localeCompare(String(a.time)))
}

function relativeTime(createdAt) {
  if (!createdAt) return ''
  const t = new Date(String(createdAt).replace(/-/g, '/')).getTime()
  if (!t) return String(createdAt)
  const diff = Math.max(0, Date.now() - t)
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const hour = Math.floor(min / 60)
  if (hour < 24) return hour + ' 小时前'
  const day = Math.floor(hour / 24)
  if (day === 1) return '昨天'
  if (day < 7) return day + ' 天前'
  return String(createdAt).slice(0, 10)
}

function isFriendPair(db, a, b) {
  if (!db || !a || !b) return false
  return db.friendships.some((f) =>
    (f.userA === a && f.userB === b) || (f.userB === a && f.userA === b)
  )
}

function createFriendship(db, userA, userB) {
  if (!userA || !userB || userA === userB) return { ok: false, error: '不能添加自己' }
  if (isFriendPair(db, userA, userB)) return { ok: false, error: '已经是好友了' }
  db.friendships.push({
    id: uid('fs_'),
    userA,
    userB,
    createdAt: nowText()
  })
  db.chatMessages.push({
    id: uid('c_'),
    fromUserId: userB,
    toUserId: userA,
    text: '我们已经成为好友啦，聊聊你家毛孩子吧～',
    time: nowText(),
    read: false
  })
  return { ok: true }
}

function mapPost(post, userId, db) {
  const likedBy = Array.isArray(post.likedBy) ? post.likedBy : []
  const commentList = Array.isArray(post.commentList) ? post.commentList : []
  const allowAddFriend = post.allowAddFriend !== false
  const mine = Boolean(userId && post.userId && post.userId === userId)
  const friend = Boolean(userId && post.userId && db && isFriendPair(db, userId, post.userId))
  const canAddFriend = Boolean(userId && post.userId && !mine && allowAddFriend && !friend)
  return {
    id: post.id,
    userId: post.userId || '',
    user: post.user,
    avatar: post.avatar || '🐾',
    city: post.city || '',
    text: post.text || '',
    imgs: Array.isArray(post.imgs) ? post.imgs : [],
    photo: post.photo || '',
    breed: post.breed || '',
    tab: post.tab || 'recommend',
    liked: userId ? likedBy.indexOf(userId) >= 0 : false,
    likes: likedBy.length || Number(post.likes) || 0,
    comments: commentList.length || Number(post.comments) || 0,
    commentPreview: commentList.slice(-2),
    time: relativeTime(post.createdAt) || post.time || '',
    createdAt: post.createdAt || '',
    mine,
    status: post.status || 'published',
    allowAddFriend,
    isFriend: friend,
    canAddFriend
  }
}

function distText(meters) {
  const m = Math.round(Number(meters) || 0)
  return m >= 1000 ? (m / 1000).toFixed(1) + 'km' : m + 'm'
}

function mapError(status, message, hint, provider) {
  const err = new Error(message)
  err.status = status
  err.hint = hint
  err.provider = provider
  return err
}

async function searchNearbyQQ(lat, lng, radius, keyword, icon) {
  const key = String(config.qqMapKey || '').trim()
  if (!key) {
    throw mapError(503, '未配置腾讯地图 Key', 'config.json 填写 qqMapKey', 'qq')
  }
  const searchUrl = 'https://apis.map.qq.com/ws/place/v1/search?keyword=' +
    encodeURIComponent(keyword) +
    '&boundary=nearby(' + lat + ',' + lng + ',' + radius + ')' +
    '&page_size=20&orderby=_distance&key=' + encodeURIComponent(key)
  const geoUrl = 'https://apis.map.qq.com/ws/geocoder/v1/?location=' +
    encodeURIComponent(lat + ',' + lng) + '&key=' + encodeURIComponent(key)
  const [poi, geo] = await Promise.all([
    httpJson(searchUrl).catch(() => null),
    httpJson(geoUrl).catch(() => null)
  ])
  if (!poi || poi.status !== 0) {
    throw mapError(502, (poi && poi.message) || '腾讯地图检索失败', '', 'qq')
  }
  const places = (poi.data || []).map((item) => {
    const meters = Math.round(Number(item._distance) || 0)
    return {
      id: item.id || (item.title + lat),
      name: item.title || '未知地点',
      address: item.address || '',
      tel: (item.tel || '').split(';')[0] || '',
      lat: item.location && item.location.lat,
      lng: item.location && item.location.lng,
      distance: meters,
      meta: distText(meters) + (item.address ? ' · ' + item.address : ''),
      icon
    }
  })
  const comp = geo && geo.status === 0 && geo.result && geo.result.address_component
  return {
    provider: 'qq',
    places,
    address: geo && geo.status === 0 && geo.result ? (geo.result.address || '') : '',
    city: comp ? (comp.city || comp.district || '') : ''
  }
}

async function searchNearbyAmap(lat, lng, radius, keyword, icon) {
  const key = String(config.amapKey || '').trim()
  if (!key) {
    throw mapError(503, '未配置高德地图 Key', 'config.json 填写 amapKey，并把 mapProvider 设为 amap', 'amap')
  }
  // 高德：location 为 经度,纬度
  const searchUrl = 'https://restapi.amap.com/v3/place/around?key=' + encodeURIComponent(key) +
    '&location=' + encodeURIComponent(lng + ',' + lat) +
    '&keywords=' + encodeURIComponent(keyword) +
    '&radius=' + encodeURIComponent(radius) +
    '&offset=20&extensions=all&sortrule=distance'
  const geoUrl = 'https://restapi.amap.com/v3/geocode/regeo?key=' + encodeURIComponent(key) +
    '&location=' + encodeURIComponent(lng + ',' + lat) +
    '&extensions=base'
  const [poi, geo] = await Promise.all([
    httpJson(searchUrl).catch(() => null),
    httpJson(geoUrl).catch(() => null)
  ])
  if (!poi || String(poi.status) !== '1') {
    throw mapError(502, (poi && (poi.info || poi.infocode)) || '高德地图检索失败', '', 'amap')
  }
  const places = (poi.pois || []).map((item) => {
    const loc = String(item.location || '').split(',')
    const itemLng = Number(loc[0])
    const itemLat = Number(loc[1])
    const meters = Math.round(Number(item.distance) || 0)
    const address = [item.pname, item.cityname, item.adname, item.address].filter(Boolean).join('')
    return {
      id: item.id || (item.name + lat),
      name: item.name || '未知地点',
      address: address || item.address || '',
      tel: String(item.tel || '').split(';')[0] || '',
      lat: itemLat,
      lng: itemLng,
      distance: meters,
      meta: distText(meters) + (address ? ' · ' + address : ''),
      icon
    }
  })
  const regeocode = geo && String(geo.status) === '1' ? geo.regeocode : null
  const addrComp = regeocode && regeocode.addressComponent
  return {
    provider: 'amap',
    places,
    address: regeocode ? (regeocode.formatted_address || '') : '',
    city: addrComp ? (addrComp.city || addrComp.province || addrComp.district || '') : ''
  }
}

async function searchNearbyBaidu(lat, lng, radius, keyword, icon) {
  const ak = String(config.baiduAk || '').trim()
  if (!ak) {
    throw mapError(503, '未配置百度地图 AK', 'config.json 填写 baiduAk，并把 mapProvider 设为 baidu', 'baidu')
  }
  // 微信定位为 gcj02；百度 place 接口用 coord_type
  const searchUrl = 'https://api.map.baidu.com/place/v2/search?query=' + encodeURIComponent(keyword) +
    '&location=' + encodeURIComponent(lat + ',' + lng) +
    '&radius=' + encodeURIComponent(radius) +
    '&output=json&scope=2&coord_type=2&ret_coordtype=gcj02ll&page_size=20&ak=' + encodeURIComponent(ak)
  const geoUrl = 'https://api.map.baidu.com/reverse_geocoding/v3/?ak=' + encodeURIComponent(ak) +
    '&output=json&coordtype=gcj02ll&ret_coordtype=gcj02ll&location=' + encodeURIComponent(lat + ',' + lng)
  const [poi, geo] = await Promise.all([
    httpJson(searchUrl).catch(() => null),
    httpJson(geoUrl).catch(() => null)
  ])
  if (!poi || poi.status !== 0) {
    throw mapError(502, (poi && poi.message) || '百度地图检索失败', '', 'baidu')
  }
  const places = (poi.results || []).map((item) => {
    const meters = Math.round(Number(item.detail_info && item.detail_info.distance) || Number(item.distance) || 0)
    return {
      id: item.uid || (item.name + lat),
      name: item.name || '未知地点',
      address: item.address || '',
      tel: (item.telephone || '').split(',')[0] || '',
      lat: item.location && item.location.lat,
      lng: item.location && item.location.lng,
      distance: meters,
      meta: distText(meters) + (item.address ? ' · ' + item.address : ''),
      icon
    }
  })
  const result = geo && geo.status === 0 ? geo.result : null
  const addrComp = result && result.addressComponent
  return {
    provider: 'baidu',
    places,
    address: result ? (result.formatted_address || '') : '',
    city: addrComp ? (addrComp.city || addrComp.district || '') : ''
  }
}

async function searchNearbyPlaces(opts) {
  const provider = String(config.mapProvider || 'amap').toLowerCase()
  if (provider === 'qq' || provider === 'tencent') {
    return searchNearbyQQ(opts.lat, opts.lng, opts.radius, opts.keyword, opts.icon)
  }
  if (provider === 'baidu') {
    return searchNearbyBaidu(opts.lat, opts.lng, opts.radius, opts.keyword, opts.icon)
  }
  return searchNearbyAmap(opts.lat, opts.lng, opts.radius, opts.keyword, opts.icon)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const pathname = url.pathname

  try {
    if (req.method === 'OPTIONS') {
      send(res, 204, '')
      return
    }

    if (pathname === '/' || pathname === '/index.html') {
      serveFile(res, path.join(publicDir, 'index.html'), 'text/html; charset=utf-8')
      return
    }

    if (pathname.startsWith('/uploads/')) {
      const safe = path.basename(pathname)
      const filePath = path.join(uploadDir, safe)
      const ext = path.extname(safe).toLowerCase()
      const types = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
      }
      serveFile(res, filePath, types[ext] || 'application/octet-stream')
      return
    }

    if (req.method === 'POST' && pathname === '/api/admin/upload') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const ctype = String(req.headers['content-type'] || '')
      let ext = '.jpg'
      if (ctype.indexOf('png') >= 0) ext = '.png'
      else if (ctype.indexOf('webp') >= 0) ext = '.webp'
      else if (ctype.indexOf('gif') >= 0) ext = '.gif'
      const hint = String(req.headers['x-filename'] || '')
      const hintExt = path.extname(hint).toLowerCase()
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].indexOf(hintExt) >= 0) ext = hintExt
      const buf = await readBody(req, 5 * 1024 * 1024)
      if (!buf.length) return send(res, 400, { error: '空文件' })
      const name = uid('img') + ext
      fs.writeFileSync(path.join(uploadDir, name), buf)
      send(res, 200, { url: '/uploads/' + name, name })
      return
    }

    // —— 管理登录 ——
    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await readJson(req)
      if (body.password !== config.password) {
        send(res, 401, { error: '密码不对' })
        return
      }
      const token = crypto.randomBytes(24).toString('hex')
      adminSessions.add(token)
      send(res, 200, { ok: true }, {
        'set-cookie': 'chongni_admin=' + token + '; HttpOnly; Path=/; SameSite=Lax'
      })
      return
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      adminSessions.delete(cookies(req).chongni_admin)
      send(res, 200, { ok: true }, {
        'set-cookie': 'chongni_admin=; HttpOnly; Path=/; Max-Age=0'
      })
      return
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      send(res, 200, { ok: isAdmin(req) })
      return
    }

    // —— 用户鉴权 ——
    if (req.method === 'POST' && pathname === '/api/auth/sms') {
      const body = await readJson(req)
      const phone = String(body.phone || '').trim()
      if (!/^1\d{10}$/.test(phone)) {
        send(res, 400, { error: '手机号不对' })
        return
      }
      const code = createSmsCode(phone)
      const payload = { ok: true, expireSec: (config.sms && config.sms.codeTtlSec) || 300 }
      if ((config.sms && config.sms.mode) === 'dev') payload.debugCode = code
      send(res, 200, payload)
      return
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJson(req)
      const phone = String(body.phone || '').trim()
      const code = String(body.code || '').trim()
      if (!/^1\d{10}$/.test(phone)) {
        send(res, 400, { error: '手机号不对' })
        return
      }
      if (!verifySmsCode(phone, code)) {
        send(res, 401, { error: '验证码错误或已过期' })
        return
      }
      const db = loadDb()
      let openid = ''
      if (body.wxCode) {
        try {
          const wx = await code2Session(body.wxCode)
          if (wx && wx.openid) openid = wx.openid
        } catch (e) {}
      }
      const city = normalizeCityName(body.city)
      const patch = {}
      if (openid) patch.openid = openid
      if (city) patch.city = city
      const user = findOrCreateUser(db, phone, Object.keys(patch).length ? patch : null)
      if ((user.status || 'active') === 'banned') {
        send(res, 403, { error: '账号已被停用，请联系客服' })
        return
      }
      saveDb(db)
      const token = issueSession(user.id)
      send(res, 200, {
        token,
        user: publicUser(user),
        pets: userPets(db, user.id)
      })
      return
    }

    if (req.method === 'POST' && pathname === '/api/auth/wx') {
      const body = await readJson(req)
      const wx = await code2Session(body.code)
      if (!wx || !wx.openid) {
        send(res, 400, { error: '微信登录未配置或 code 无效，请先配置 wx.appId/appSecret，或使用手机号登录' })
        return
      }
      const db = loadDb()
      let user = db.users.find((u) => u.openid === wx.openid)
      if (!user && body.phone && /^1\d{10}$/.test(body.phone)) {
        if (!verifySmsCode(body.phone, body.smsCode || '')) {
          send(res, 401, { error: '绑定手机需要正确的验证码' })
          return
        }
        user = findOrCreateUser(db, body.phone, { openid: wx.openid })
      }
      if (!user) {
        send(res, 404, { error: '请先用手机号注册并绑定微信', needBind: true, openidHint: true })
        return
      }
      saveDb(db)
      const token = issueSession(user.id)
      send(res, 200, { token, user: publicUser(user), pets: userPets(db, user.id) })
      return
    }

    if (req.method === 'GET' && pathname === '/api/auth/profile') {
      const auth = getUser(req)
      if (!auth) {
        send(res, 401, { error: '未登录' })
        return
      }
      send(res, 200, {
        user: publicUser(auth.user),
        pets: userPets(auth.db, auth.user.id)
      })
      return
    }

    if (req.method === 'PUT' && pathname === '/api/auth/profile') {
      const auth = getUser(req)
      if (!auth) {
        send(res, 401, { error: '未登录' })
        return
      }
      const body = await readJson(req)
      const db = loadDb()
      const user = db.users.find((u) => u.id === auth.user.id)
      if (!user) {
        send(res, 404, { error: '用户不存在' })
        return
      }
      if (body.nickname !== undefined) user.nickname = String(body.nickname || '').trim() || user.nickname
      if (body.city !== undefined) {
        const city = normalizeCityName(body.city)
        if (city) user.city = city
      }
      if (body.avatar !== undefined) user.avatar = String(body.avatar || '🐾').slice(0, 4)
      saveDb(db)
      send(res, 200, { user: publicUser(user) })
      return
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const token = getBearer(req)
      if (token) userSessions.delete(token)
      send(res, 200, { ok: true })
      return
    }

    // —— 公开：商品 / 地点 / 动态流 ——
    if (req.method === 'GET' && pathname === '/api/goods') {
      const db = loadDb()
      const goods = isAdmin(req) ? db.goods : db.goods.filter((g) => g.onSale)
      send(res, 200, { goods, cats: CATS })
      return
    }

    // 单品详情（公开上架商品；管理员可读全部）
    // 注意：具体路由在下方 goodsPath 统一处理 GET

    if (req.method === 'GET' && pathname === '/api/places') {
      // 兼容旧接口；附近页已改为地图周边检索
      const db = loadDb()
      send(res, 200, {
        hospitals: db.places.hospitals || [],
        shops: db.places.shops || [],
        deprecated: true
      })
      return
    }

    // 地图：逆地理 + 周边 POI（qq / amap / baidu，Key 仅存服务端）
    if (req.method === 'GET' && pathname === '/api/map/nearby') {
      const lat = Number(url.searchParams.get('lat'))
      const lng = Number(url.searchParams.get('lng'))
      const type = String(url.searchParams.get('type') || 'hospital')
      const radius = Math.min(20000, Math.max(500, Number(url.searchParams.get('radius')) || config.nearbyRadius || 5000))
      if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) {
        send(res, 400, { error: '定位坐标无效' })
        return
      }
      const keyword = type === 'shop' ? '宠物店' : '宠物医院'
      const icon = type === 'shop' ? '🏪' : '🏥'
      try {
        const result = await searchNearbyPlaces({ lat, lng, radius, keyword, icon })
        send(res, 200, Object.assign({ keyword, radius, provider: result.provider }, result))
      } catch (err) {
        send(res, err.status || 502, {
          error: err.message || '地图检索失败',
          hint: err.hint || '',
          places: [],
          address: '',
          city: '',
          provider: err.provider || config.mapProvider || 'amap'
        })
      }
      return
    }

    if (req.method === 'GET' && pathname === '/api/posts') {
      const auth = getUser(req)
      const db = loadDb()
      const tab = url.searchParams.get('tab') || 'recommend'
      const city = url.searchParams.get('city') || (auth ? auth.user.city : '')
      const breed = url.searchParams.get('breed') || ''
      let posts = db.posts.filter((p) => p.status !== 'hidden')
      posts.forEach((p) => {
        if (!Array.isArray(p.commentList)) p.commentList = []
        if (!Array.isArray(p.likedBy)) p.likedBy = []
      })
      if (tab === 'city' && city) {
        const cityKey = String(city).replace(/市$/, '')
        posts = posts.filter((p) => String(p.city || '').indexOf(cityKey) >= 0)
      }
      if (tab === 'breed' && breed) {
        const key = String(breed).slice(0, 2)
        posts = posts.filter((p) => String(p.breed || '').indexOf(key) >= 0)
      }
      if (tab === 'mine') {
        if (!auth) return send(res, 401, { error: '未登录' })
        posts = posts.filter((p) => p.userId === auth.user.id)
      }
      posts = posts.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      send(res, 200, {
        posts: posts.map((p) => mapPost(p, auth ? auth.user.id : '', db)),
        city: city || '',
        breed: breed || ''
      })
      return
    }

    // —— 需要登录的用户接口 ——
    const needUser = pathname.startsWith('/api/') && !pathname.startsWith('/api/login') &&
      !pathname.startsWith('/api/logout') && !pathname.startsWith('/api/me') &&
      !pathname.startsWith('/api/auth/') && pathname !== '/api/goods' &&
      pathname !== '/api/places' && pathname !== '/api/posts'

    // 管理端商品/订单/用户等：admin 或 user 分开处理
    const adminOnlyWrite = (
      (pathname.startsWith('/api/goods') && req.method !== 'GET') ||
      (pathname === '/api/orders' && req.method === 'GET') ||
      (pathname.startsWith('/api/admin/'))
    )

    if (adminOnlyWrite && !isAdmin(req)) {
      // goods write admin only; GET orders list admin only handled below
    }

    // 宠物
    if (pathname === '/api/pets' && req.method === 'GET') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      send(res, 200, { pets: userPets(auth.db, auth.user.id) })
      return
    }

    if (pathname === '/api/pets' && req.method === 'POST') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const body = await readJson(req, 2000000)
      const name = String(body.name || '').trim()
      if (!name) return send(res, 400, { error: '请填写宠物名' })
      const db = loadDb()
      const pet = {
        id: uid('pet_'),
        userId: auth.user.id,
        species: body.species || 'cat',
        name,
        breed: body.breed || '',
        gender: body.gender || '未知',
        birthday: body.birthday || '',
        weight: body.weight === '' || body.weight == null ? '' : Number(body.weight),
        avatar: body.avatar || '🐾',
        photo: String(body.photo || '').slice(0, 1200000),
        createdAt: nowText()
      }
      db.pets.push(pet)
      saveDb(db)
      send(res, 200, { pet })
      return
    }

    const petPath = pathname.match(/^\/api\/pets\/([^/]+)$/)
    if (petPath && req.method === 'PUT') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const id = decodeURIComponent(petPath[1])
      const body = await readJson(req, 2000000)
      const db = loadDb()
      const pet = db.pets.find((p) => p.id === id && p.userId === auth.user.id)
      if (!pet) return send(res, 404, { error: '找不到宠物' })
      ;['name', 'breed', 'gender', 'birthday', 'species', 'avatar', 'photo'].forEach((k) => {
        if (body[k] !== undefined) pet[k] = body[k]
      })
      if (body.weight !== undefined) pet.weight = body.weight === '' ? '' : Number(body.weight)
      saveDb(db)
      send(res, 200, { pet })
      return
    }

    // 提醒 / 花销 / 病例
    if (pathname === '/api/reminders' && req.method === 'GET') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const petIds = userPets(auth.db, auth.user.id).map((p) => p.id)
      send(res, 200, {
        reminders: auth.db.reminders.filter((r) => petIds.indexOf(r.petId) >= 0 || r.userId === auth.user.id)
      })
      return
    }

    if (pathname === '/api/reminders' && req.method === 'POST') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const body = await readJson(req)
      const title = String(body.title || '').trim()
      if (!title) return send(res, 400, { error: '请填写提醒内容' })
      const db = loadDb()
      const item = {
        id: uid('rem_'),
        userId: auth.user.id,
        type: body.type || 'other',
        title,
        date: body.date || today(),
        repeat: body.repeat || '不重复',
        petId: body.petId || '',
        petName: body.petName || '',
        note: body.note || '',
        done: false
      }
      db.reminders.push(item)
      saveDb(db)
      send(res, 200, { reminder: item })
      return
    }

    const remPath = pathname.match(/^\/api\/reminders\/([^/]+)$/)
    if (remPath && req.method === 'PATCH') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const id = decodeURIComponent(remPath[1])
      const body = await readJson(req)
      const db = loadDb()
      const item = db.reminders.find((r) => r.id === id && r.userId === auth.user.id)
      if (!item) return send(res, 404, { error: '找不到提醒' })
      if (body.done !== undefined) item.done = Boolean(body.done)
      saveDb(db)
      send(res, 200, { reminder: item })
      return
    }

    if (pathname === '/api/expenses' && req.method === 'GET') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      send(res, 200, {
        expenses: auth.db.expenses.filter((e) => e.userId === auth.user.id)
      })
      return
    }

    if (pathname === '/api/expenses' && req.method === 'POST') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const body = await readJson(req)
      const title = String(body.title || '').trim()
      const amount = Number(body.amount)
      if (!title || !(amount >= 0)) return send(res, 400, { error: '请填写花销与金额' })
      const db = loadDb()
      const item = {
        id: uid('exp_'),
        userId: auth.user.id,
        title,
        amount,
        cat: body.cat || '其他',
        date: body.date || today(),
        petId: body.petId || '',
        petName: body.petName || ''
      }
      db.expenses.push(item)
      saveDb(db)
      send(res, 200, { expense: item })
      return
    }

    if (pathname === '/api/cases' && req.method === 'GET') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      send(res, 200, {
        cases: auth.db.cases.filter((c) => c.userId === auth.user.id)
      })
      return
    }

    if (pathname === '/api/cases' && req.method === 'POST') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const body = await readJson(req)
      const title = String(body.title || '').trim()
      if (!title) return send(res, 400, { error: '请填写病例标题' })
      const db = loadDb()
      const item = {
        id: uid('case_'),
        userId: auth.user.id,
        title,
        date: body.date || today(),
        hospital: body.hospital || '',
        note: body.note || '',
        petId: body.petId || '',
        petName: body.petName || ''
      }
      db.cases.push(item)
      saveDb(db)
      send(res, 200, { case: item })
      return
    }

    // 同步包：登录后一次拉齐
    if (pathname === '/api/sync' && req.method === 'GET') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const db = auth.db
      const uid_ = auth.user.id
      send(res, 200, {
        user: publicUser(auth.user),
        pets: userPets(db, uid_),
        reminders: db.reminders.filter((r) => r.userId === uid_),
        expenses: db.expenses.filter((e) => e.userId === uid_),
        cases: db.cases.filter((c) => c.userId === uid_),
        friends: buildFriendList(db, uid_),
        messages: inbox(db, uid_),
        orders: db.orders.filter((o) => o.userId === uid_).slice().reverse(),
        unread: db.chatMessages.filter((m) => m.toUserId === uid_ && !m.read).length
      })
      return
    }

    // 动态发布 / 点赞 / 评论 / 删除
    if (pathname === '/api/posts' && req.method === 'POST') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const body = await readJson(req, 2000000)
      const text = String(body.text || '').trim()
      if (!text) return send(res, 400, { error: '写点内容再发布' })
      if (text.length > 500) return send(res, 400, { error: '内容太长，最多 500 字' })
      const db = loadDb()
      const pets = userPets(db, auth.user.id)
      let imgs = Array.isArray(body.imgs) ? body.imgs.filter(Boolean).slice(0, 4) : []
      if (!imgs.length) imgs = ['✨', '🐾']
      const post = {
        id: uid('p_'),
        userId: auth.user.id,
        user: auth.user.nickname,
        avatar: auth.user.avatar || '🐾',
        city: (auth.user.city ? (auth.user.city + ' · 同城') : '同城'),
        text,
        imgs,
        photo: String(body.photo || '').slice(0, 900000),
        likes: 0,
        comments: 0,
        commentList: [],
        likedBy: [],
        tab: body.tab === 'breed' ? 'breed' : 'city',
        breed: pets[0] ? pets[0].breed : '',
        allowAddFriend: body.allowAddFriend !== false && body.allowAddFriend !== 0 && body.allowAddFriend !== '0',
        createdAt: nowText(),
        status: 'published'
      }
      db.posts.unshift(post)
      saveDb(db)
      send(res, 200, { post: mapPost(post, auth.user.id, db) })
      return
    }

    const postLike = pathname.match(/^\/api\/posts\/([^/]+)\/like$/)
    if (postLike && req.method === 'POST') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const id = decodeURIComponent(postLike[1])
      const db = loadDb()
      const post = db.posts.find((p) => p.id === id)
      if (!post) return send(res, 404, { error: '动态不存在' })
      if (!Array.isArray(post.likedBy)) post.likedBy = []
      const idx = post.likedBy.indexOf(auth.user.id)
      if (idx >= 0) post.likedBy.splice(idx, 1)
      else post.likedBy.push(auth.user.id)
      post.likes = post.likedBy.length
      saveDb(db)
      send(res, 200, { post: mapPost(post, auth.user.id, db) })
      return
    }

    const postComments = pathname.match(/^\/api\/posts\/([^/]+)\/comments$/)
    if (postComments && req.method === 'GET') {
      const id = decodeURIComponent(postComments[1])
      const db = loadDb()
      const post = db.posts.find((p) => p.id === id)
      if (!post || post.status === 'hidden') return send(res, 404, { error: '动态不存在' })
      if (!Array.isArray(post.commentList)) post.commentList = []
      send(res, 200, { comments: post.commentList.slice().reverse() })
      return
    }

    if (postComments && req.method === 'POST') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const id = decodeURIComponent(postComments[1])
      const body = await readJson(req)
      const text = String(body.text || '').trim()
      if (!text) return send(res, 400, { error: '写点评论吧' })
      if (text.length > 200) return send(res, 400, { error: '评论最多 200 字' })
      const db = loadDb()
      const post = db.posts.find((p) => p.id === id)
      if (!post || post.status === 'hidden') return send(res, 404, { error: '动态不存在' })
      if (!Array.isArray(post.commentList)) post.commentList = []
      const comment = {
        id: uid('cm_'),
        userId: auth.user.id,
        user: auth.user.nickname,
        avatar: auth.user.avatar || '🐾',
        text,
        createdAt: nowText(),
        time: '刚刚'
      }
      post.commentList.push(comment)
      post.comments = post.commentList.length
      saveDb(db)
      send(res, 200, {
        comment,
        post: mapPost(post, auth.user.id, db)
      })
      return
    }

    const postOne = pathname.match(/^\/api\/posts\/([^/]+)$/)
    if (postOne && req.method === 'DELETE') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const id = decodeURIComponent(postOne[1])
      const db = loadDb()
      const post = db.posts.find((p) => p.id === id)
      if (!post) return send(res, 404, { error: '动态不存在' })
      if (post.userId !== auth.user.id && !isAdmin(req)) {
        return send(res, 403, { error: '只能删除自己的动态' })
      }
      db.posts = db.posts.filter((p) => p.id !== id)
      saveDb(db)
      send(res, 200, { ok: true })
      return
    }

    if (postOne && req.method === 'GET') {
      const auth = getUser(req)
      const id = decodeURIComponent(postOne[1])
      const db = loadDb()
      const post = db.posts.find((p) => p.id === id && p.status !== 'hidden')
      if (!post) return send(res, 404, { error: '动态不存在' })
      if (!Array.isArray(post.commentList)) post.commentList = []
      send(res, 200, {
        post: mapPost(post, auth ? auth.user.id : '', db),
        comments: post.commentList.slice().reverse()
      })
      return
    }

    // 好友（手机号 / 动态作者均可添加，不限制好友人数）
    if (pathname === '/api/friends' && req.method === 'GET') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      send(res, 200, { friends: buildFriendList(auth.db, auth.user.id) })
      return
    }

    if (pathname === '/api/friends' && req.method === 'POST') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const body = await readJson(req)
      const db = loadDb()
      let other = null
      const postId = String(body.postId || '').trim()
      const userId = String(body.userId || '').trim()
      const phone = String(body.phone || '').trim()

      if (postId) {
        const post = db.posts.find((p) => p.id === postId && p.status !== 'hidden')
        if (!post) return send(res, 404, { error: '动态不存在' })
        if (post.allowAddFriend === false) {
          return send(res, 403, { error: '作者关闭了通过动态加好友' })
        }
        if (!post.userId) return send(res, 400, { error: '无法添加该作者' })
        other = db.users.find((u) => u.id === post.userId)
        if (!other) return send(res, 404, { error: '对方账号不存在' })
      } else if (userId) {
        other = db.users.find((u) => u.id === userId)
        if (!other) return send(res, 404, { error: '对方账号不存在' })
      } else if (phone) {
        if (!/^1\d{10}$/.test(phone)) return send(res, 400, { error: '请填写对方注册手机号' })
        if (phone === auth.user.phone) return send(res, 400, { error: '不能添加自己' })
        other = db.users.find((u) => u.phone === phone)
        if (!other) return send(res, 404, { error: '对方还没注册宠溺' })
      } else {
        return send(res, 400, { error: '请通过动态或手机号添加好友' })
      }

      const result = createFriendship(db, auth.user.id, other.id)
      if (!result.ok) return send(res, 400, { error: result.error })
      saveDb(db)
      send(res, 200, { friends: buildFriendList(db, auth.user.id), friendId: other.id })
      return
    }

    if (pathname === '/api/messages' && req.method === 'GET') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      send(res, 200, {
        messages: inbox(auth.db, auth.user.id),
        unread: auth.db.chatMessages.filter((m) => m.toUserId === auth.user.id && !m.read).length
      })
      return
    }

    const chatPath = pathname.match(/^\/api\/chat\/([^/]+)$/)
    if (chatPath && req.method === 'GET') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const friendId = decodeURIComponent(chatPath[1])
      if (friendIdsOf(auth.db, auth.user.id).indexOf(friendId) < 0) {
        return send(res, 403, { error: '还不是好友' })
      }
      const list = auth.db.chatMessages
        .filter((m) =>
          (m.fromUserId === auth.user.id && m.toUserId === friendId) ||
          (m.fromUserId === friendId && m.toUserId === auth.user.id)
        )
        .map((m) => ({
          id: m.id,
          from: m.fromUserId === auth.user.id ? 'me' : 'friend',
          text: m.text,
          time: m.time,
          unread: !m.read && m.toUserId === auth.user.id
        }))
      send(res, 200, { messages: list })
      return
    }

    if (chatPath && req.method === 'POST') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const friendId = decodeURIComponent(chatPath[1])
      const body = await readJson(req)
      const text = String(body.text || '').trim()
      if (!text) return send(res, 400, { error: '消息不能为空' })
      const db = loadDb()
      if (friendIdsOf(db, auth.user.id).indexOf(friendId) < 0) {
        return send(res, 403, { error: '还不是好友' })
      }
      const msg = {
        id: uid('c_'),
        fromUserId: auth.user.id,
        toUserId: friendId,
        text,
        time: nowText(),
        read: false
      }
      db.chatMessages.push(msg)
      saveDb(db)
      send(res, 200, {
        message: {
          id: msg.id,
          from: 'me',
          text: msg.text,
          time: msg.time,
          unread: false
        }
      })
      return
    }

    if (chatPath && req.method === 'PATCH') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const friendId = decodeURIComponent(chatPath[1])
      const db = loadDb()
      db.chatMessages.forEach((m) => {
        if (m.fromUserId === friendId && m.toUserId === auth.user.id) m.read = true
      })
      saveDb(db)
      send(res, 200, { ok: true })
      return
    }

    // 订单
    if (pathname === '/api/orders/mine' && req.method === 'GET') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const orders = auth.db.orders.filter((o) => o.userId === auth.user.id).slice().reverse()
      send(res, 200, { orders })
      return
    }

    if (pathname === '/api/orders' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const db = loadDb()
      send(res, 200, { orders: db.orders.slice().reverse() })
      return
    }

    if (pathname === '/api/orders' && req.method === 'POST') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const body = await readJson(req)
      const name = String(body.name || '').trim()
      const phone = String(body.phone || '').trim()
      const address = String(body.address || '').trim()
      const items = Array.isArray(body.items) ? body.items : []
      if (!name || !/^1\d{10}$/.test(phone) || address.length < 6 || !items.length) {
        return send(res, 400, { error: '订单信息不完整' })
      }
      const db = loadDb()
      const lines = []
      for (let i = 0; i < items.length; i++) {
        const raw = items[i]
        const goods = db.goods.find((g) => g.id === String(raw.id || ''))
        if (!goods || !goods.onSale) return send(res, 400, { error: '有商品已下架' })
        const count = Math.max(1, Math.min(99, Number(raw.count) || 1))
        if (goods.stock < count) return send(res, 400, { error: goods.name + ' 库存不足' })
        lines.push({
          id: goods.id,
          name: goods.name,
          icon: goods.icon,
          price: goods.price,
          count
        })
      }
      const amount = lines.reduce((s, l) => s + l.price * l.count, 0)
      lines.forEach((line) => {
        const goods = db.goods.find((g) => g.id === line.id)
        goods.stock -= line.count
        const soldNum = parseFloat(String(goods.sold).replace(/k/i, '')) || 0
        if (/k$/i.test(String(goods.sold))) {
          goods.sold = (soldNum + line.count / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
        } else {
          goods.sold = String(Math.round(soldNum + line.count))
        }
      })
      const order = {
        id: uid('o'),
        userId: auth.user.id,
        name,
        phone,
        address,
        remark: String(body.remark || ''),
        items: lines,
        amount,
        status: 'pending',
        statusText: '待发货',
        payStatus: 'unpaid',
        payStatusText: '待支付',
        createdAt: nowText()
      }
      db.orders.push(order)
      saveDb(db)
      send(res, 200, { order, payMode: config.payMode || 'sandbox' })
      return
    }

    const orderPay = pathname.match(/^\/api\/orders\/([^/]+)\/pay$/)
    if (orderPay && req.method === 'POST') {
      const auth = getUser(req)
      if (!auth) return send(res, 401, { error: '未登录' })
      const id = decodeURIComponent(orderPay[1])
      const db = loadDb()
      const order = db.orders.find((o) => o.id === id && o.userId === auth.user.id)
      if (!order) return send(res, 404, { error: '订单不存在' })
      if (order.payStatus === 'paid') return send(res, 200, { order, already: true })
      const mode = config.payMode || 'sandbox'
      if (mode === 'wechat') {
        const mch = config.wx || {}
        if (!mch.mchId || !mch.apiKey) {
          return send(res, 503, {
            error: '尚未配置微信支付商户号，请在 config.json 填写 wx.mchId/apiKey，或暂用 payMode: sandbox'
          })
        }
        return send(res, 501, {
          error: '请接入微信统一下单后返回支付参数',
          hint: '配置商户后在此生成 wx.requestPayment 参数'
        })
      }
      order.payStatus = 'paid'
      order.payStatusText = '已支付'
      order.paidAt = nowText()
      saveDb(db)
      send(res, 200, { order, payMode: 'sandbox' })
      return
    }

    const orderPath = pathname.match(/^\/api\/orders\/([^/]+)$/)
    if (orderPath && req.method === 'PATCH') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const id = decodeURIComponent(orderPath[1])
      const body = await readJson(req)
      const db = loadDb()
      const order = db.orders.find((o) => o.id === id)
      if (!order) return send(res, 404, { error: '没有这张订单' })
      if (ORDER_STATUS[body.status]) {
        order.status = body.status
        order.statusText = ORDER_STATUS[body.status]
      }
      if (PAY_STATUS[body.payStatus]) {
        order.payStatus = body.payStatus
        order.payStatusText = PAY_STATUS[body.payStatus]
      }
      if (body.remark !== undefined) order.remark = String(body.remark || '')
      saveDb(db)
      send(res, 200, { order })
      return
    }

    // 商品管理
    if (pathname === '/api/goods' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const body = await readJson(req, 2 * 1024 * 1024)
      const goods = normalizeGoods(body)
      if (!goods) return send(res, 400, { error: '请填写商品名和价格' })
      const db = loadDb()
      db.goods.push(goods)
      saveDb(db)
      send(res, 200, { goods })
      return
    }

    const goodsPath = pathname.match(/^\/api\/goods\/([^/]+)$/)
    if (goodsPath && req.method === 'GET') {
      const id = decodeURIComponent(goodsPath[1])
      const db = loadDb()
      const goods = db.goods.find((g) => g.id === id)
      if (!goods) return send(res, 404, { error: '没有这个商品' })
      if (!isAdmin(req) && !goods.onSale) return send(res, 404, { error: '商品已下架' })
      send(res, 200, { goods: ensureGoodsFields([goods])[0] })
      return
    }

    if (goodsPath && req.method === 'PUT') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const id = decodeURIComponent(goodsPath[1])
      const body = await readJson(req, 2 * 1024 * 1024)
      const next = normalizeGoods(body, id)
      if (!next) return send(res, 400, { error: '请填写商品名和价格' })
      const db = loadDb()
      const index = db.goods.findIndex((g) => g.id === id)
      if (index < 0) return send(res, 404, { error: '没有这个商品' })
      db.goods[index] = next
      saveDb(db)
      send(res, 200, { goods: next })
      return
    }

    if (goodsPath && req.method === 'DELETE') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const id = decodeURIComponent(goodsPath[1])
      const db = loadDb()
      db.goods = db.goods.filter((g) => g.id !== id)
      saveDb(db)
      send(res, 200, { ok: true })
      return
    }

    // 地点维护
    if (pathname === '/api/admin/places' && req.method === 'PUT') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const body = await readJson(req)
      const db = loadDb()
      if (Array.isArray(body.hospitals)) db.places.hospitals = body.hospitals
      if (Array.isArray(body.shops)) db.places.shops = body.shops
      saveDb(db)
      send(res, 200, { places: db.places })
      return
    }

    if (pathname === '/api/admin/users' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const db = loadDb()
      send(res, 200, {
        users: db.users.map((u) => Object.assign(publicUser(u), {
          petCount: userPets(db, u.id).length,
          orderCount: db.orders.filter((o) => o.userId === u.id).length,
          postCount: db.posts.filter((p) => p.userId === u.id).length,
          createdAt: u.createdAt || u.joinedAt || ''
        }))
      })
      return
    }

    const adminUserPath = pathname.match(/^\/api\/admin\/users\/([^/]+)$/)
    if (adminUserPath && req.method === 'PATCH') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const id = decodeURIComponent(adminUserPath[1])
      const body = await readJson(req)
      const db = loadDb()
      const user = db.users.find((u) => u.id === id)
      if (!user) return send(res, 404, { error: '用户不存在' })
      if (body.nickname !== undefined) user.nickname = String(body.nickname || '').trim() || user.nickname
      if (body.city !== undefined) user.city = String(body.city || '').trim() || user.city
      if (body.avatar !== undefined) user.avatar = String(body.avatar || '🐾').slice(0, 4)
      if (body.status === 'active' || body.status === 'banned') {
        user.status = body.status
        if (body.status === 'banned') revokeUserSessions(user.id)
      }
      saveDb(db)
      send(res, 200, { user: publicUser(user) })
      return
    }

    if (pathname === '/api/admin/pets' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const db = loadDb()
      const pets = db.pets.map((p) => {
        const owner = db.users.find((u) => u.id === p.userId)
        return Object.assign({}, p, {
          photo: p.photo ? '[已上传]' : '',
          ownerName: owner ? owner.nickname : '',
          ownerPhone: owner ? owner.phone : ''
        })
      }).reverse()
      send(res, 200, { pets })
      return
    }

    if (pathname === '/api/admin/social' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const db = loadDb()
      const pairs = db.friendships.map((f) => {
        const a = db.users.find((u) => u.id === f.userA)
        const b = db.users.find((u) => u.id === f.userB)
        const msgCount = db.chatMessages.filter((m) =>
          (m.fromUserId === f.userA && m.toUserId === f.userB) ||
          (m.fromUserId === f.userB && m.toUserId === f.userA)
        ).length
        return {
          id: f.id,
          createdAt: f.createdAt,
          userA: a ? publicUser(a) : { id: f.userA, nickname: '已注销' },
          userB: b ? publicUser(b) : { id: f.userB, nickname: '已注销' },
          msgCount
        }
      }).reverse()
      send(res, 200, {
        friendships: pairs,
        messageTotal: db.chatMessages.length,
        unreadTotal: db.chatMessages.filter((m) => !m.read).length
      })
      return
    }

    if (pathname === '/api/admin/posts' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const db = loadDb()
      send(res, 200, {
        posts: db.posts.map((p) => Object.assign({}, mapPost(p, '', db), {
          likedByCount: Array.isArray(p.likedBy) ? p.likedBy.length : 0,
          commentCount: Array.isArray(p.commentList) ? p.commentList.length : Number(p.comments) || 0,
          status: p.status || 'published',
          rawText: p.text
        }))
      })
      return
    }

    const hidePost = pathname.match(/^\/api\/admin\/posts\/([^/]+)$/)
    if (hidePost && req.method === 'PATCH') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const id = decodeURIComponent(hidePost[1])
      const body = await readJson(req)
      const db = loadDb()
      const post = db.posts.find((p) => p.id === id)
      if (!post) return send(res, 404, { error: '动态不存在' })
      if (body.status) post.status = body.status
      saveDb(db)
      send(res, 200, { post: mapPost(post, '', db) })
      return
    }

    if (hidePost && req.method === 'DELETE') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const id = decodeURIComponent(hidePost[1])
      const db = loadDb()
      const before = db.posts.length
      db.posts = db.posts.filter((p) => p.id !== id)
      if (db.posts.length === before) return send(res, 404, { error: '动态不存在' })
      saveDb(db)
      send(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/admin/stats' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      send(res, 200, buildDashboard(loadDb()))
      return
    }

    if (pathname === '/api/admin/system' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: '需要管理员' })
      const provider = config.mapProvider || 'amap'
      send(res, 200, {
        port: PORT,
        payMode: config.payMode || 'sandbox',
        smsMode: (config.sms && config.sms.mode) || 'dev',
        mapProvider: provider,
        qqMapKeySet: Boolean(config.qqMapKey),
        amapKeySet: Boolean(config.amapKey),
        baiduAkSet: Boolean(config.baiduAk),
        wxAppIdSet: Boolean(config.wx && config.wx.appId),
        wxPayReady: Boolean(config.wx && config.wx.mchId && config.wx.apiKey),
        nearbyRadius: config.nearbyRadius || 5000,
        publicBase: config.publicBase || '',
        adminSessions: adminSessions.size,
        userSessions: userSessions.size
      })
      return
    }

    // 兜底：未匹配且 needUser
    if (needUser && !getUser(req) && !isAdmin(req)) {
      send(res, 401, { error: '未登录' })
      return
    }

    send(res, 404, { error: '没有这个地址' })
  } catch (error) {
    console.error(error)
    send(res, 500, { error: '后台处理失败' })
  }
})

// 兼容旧 db：启动时迁移
;(function migrate() {
  const db = loadDb()
  saveDb(db)
})()

server.listen(PORT, '0.0.0.0', () => {
  console.log('宠溺服务端 http://127.0.0.1:' + PORT)
  console.log('支付模式:', config.payMode || 'sandbox', '| 短信模式:', (config.sms && config.sms.mode) || 'dev')
})
