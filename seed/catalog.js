const breeds = {
  cat: ['中华田园猫', '英短', '美短', '布偶', '暹罗', '橘猫'],
  dog: ['中华田园犬', '柯基', '金毛', '泰迪', '柴犬', '边牧'],
  reptile: ['鬃狮蜥', '豹纹守宫', '玉米蛇', '陆龟', '巴西龟']
}

const emojis = {
  cat: ['🐱', '😺', '😸', '😻', '🐈', '🐈‍⬛'],
  dog: ['🐶', '🐕', '🦮', '🐩', '🐺', '🦴'],
  reptile: ['🦎', '🐢', '🐍', '🐊', '🦕', '🦖']
}

const reminderTypes = [
  { id: 'worm', name: '驱虫', color: '#E24B4B', icon: '💊' },
  { id: 'vaccine', name: '疫苗', color: '#F0A202', icon: '💉' },
  { id: 'clean', name: '清洁', color: '#2F9E6B', icon: '🛁' },
  { id: 'other', name: '其他', color: '#5B7CFA', icon: '⭐' }
]

const expenseCats = ['主粮', '零食', '医疗', '用品', '美容', '其他']

const posts = [
  {
    id: 'p1',
    user: '煤球他妈',
    avatar: '🐱',
    city: '上海 · 同城',
    time: '2 小时前',
    text: '第一次带小煤球去洗澡，全程骂骂咧咧，出来又是一条好汉。给它吹毛的时候居然睡着了……',
    imgs: ['🛁', '💤'],
    likes: 132,
    comments: 18,
    liked: false,
    tab: 'city',
    breed: '英短'
  },
  {
    id: 'p2',
    user: '短腿不加冰',
    avatar: '🐶',
    city: '上海 · 同城',
    time: '昨天',
    text: '柯基小短腿今天第一次下水，扑腾了三下就坐着喊救命，笑死我了。',
    imgs: ['🌊', '🐕'],
    likes: 86,
    comments: 9,
    liked: false,
    tab: 'city',
    breed: '柯基'
  },
  {
    id: 'p3',
    user: '爬宠日记',
    avatar: '🦎',
    city: '杭州',
    time: '3 天前',
    text: '鬃狮蜥换皮成功，皮肤油亮亮的，今天奖励一只小蟋蟀。',
    imgs: ['🌿', '🦗'],
    likes: 41,
    comments: 5,
    liked: false,
    tab: 'breed',
    breed: '鬃狮蜥'
  }
]

const friends = [
  { id: 'f1', name: '煤球他妈', avatar: '🐱', detail: '上海 · 小煤球（英短）' },
  { id: 'f2', name: '短腿不加冰', avatar: '🐶', detail: '上海 · 短腿（柯基）' },
  { id: 'f3', name: '橘座在逃', avatar: '😺', detail: '上海 · 大橘（中华田园猫）' },
  { id: 'f4', name: '汪星人阿发', avatar: '🐕', detail: '苏州 · 阿发（金毛）' },
  { id: 'f5', name: '龟龟慢生活', avatar: '🐢', detail: '杭州 · 小绿（巴西龟）' }
]

const messages = [
  { id: 'm1', friendId: 'f1', from: '煤球他妈', text: '周末带猫去医院一起吗？', unread: true },
  { id: 'm2', friendId: 'f2', from: '短腿不加冰', text: '你家那只洗澡还闹吗哈哈', unread: true },
  { id: 'm3', friendId: '', from: '系统通知', text: '欢迎来到宠溺本地演示版', unread: false }
]

const hospitals = [
  { name: '瑞鹏宠物医院 · 徐汇店', meta: '1.2km · 今日可挂号 · 评分 4.8', icon: '🏥' },
  { name: '安安宠医 · 静安中心', meta: '2.4km · 24小时急诊 · 评分 4.7', icon: '🏥' },
  { name: '宠福鑫动物医院', meta: '3.1km · 猫科专科 · 评分 4.6', icon: '🏥' }
]

const shops = [
  { name: '宠物家 · 五角场店', meta: '0.8km · 洗护美容 · 今日营业', icon: '🏪' },
  { name: '疯狂小狗生活馆', meta: '1.6km · 寄养寄养 · 今日营业', icon: '🏪' },
  { name: '喵呜生活馆', meta: '2.2km · 猫咖可探店 · 今日营业', icon: '☕' }
]

const goods = [
  {
    id: 'g1', name: '无谷冻干双拼猫粮 2kg', sold: '2.3k', price: 159, cat: '主粮', icon: '🍗', stock: 86,
    desc: '高蛋白低敏配方，适合日常主食',
    intro: '精选鲜肉与冻干双拼，无谷低敏，适口性好。\n适合成年猫日常喂养，建议按体重分餐投喂，并搭配充足饮水。'
  },
  {
    id: 'g2', name: '鲜肉低敏犬粮 3kg', sold: '1.8k', price: 189, cat: '主粮', icon: '🥩', stock: 64,
    desc: '单一蛋白来源，肠胃更友好',
    intro: '鲜肉配方，减少谷物刺激，适合肠胃敏感犬。\n颗粒适中易咀嚼，建议过渡换粮 7 天。'
  },
  {
    id: 'g3', name: '猫咪冻干零食桶', sold: '3.1k', price: 49, cat: '零食', icon: '🍤', stock: 120,
    desc: '训练奖励与拌粮神器',
    intro: '纯肉冻干，锁住鲜味与营养。\n可作零食奖励，也可掰碎拌粮提升食欲。注意控制每日零食占比。'
  },
  {
    id: 'g4', name: '狗狗洁齿磨牙棒', sold: '2.0k', price: 29, cat: '零食', icon: '🦴', stock: 200,
    desc: '清洁牙齿 · 磨牙解闷',
    intro: '螺旋纹理设计，帮助清洁牙垢。\n建议在监护下啃咬，按犬只体型选用合适尺寸。'
  },
  {
    id: 'g5', name: '自动饮水机', sold: '960', price: 129, cat: '用品', icon: '💧', stock: 42,
    desc: '循环活水，鼓励多喝水',
    intro: '三层过滤循环，水流声轻柔。\n建议每周清洗滤芯与水箱，保持饮水卫生。'
  },
  {
    id: 'g6', name: '逗猫棒套装', sold: '4.2k', price: 19, cat: '玩具', icon: '🪶', stock: 300,
    desc: '羽毛铃铛替换头 3 件套',
    intro: '多款替换头满足追扑兴趣。\n每天互动 10–15 分钟，帮助消耗精力、增进感情。'
  },
  {
    id: 'g7', name: '体内外驱虫套装', sold: '1.1k', price: 98, cat: '健康', icon: '💊', stock: 55,
    desc: '内外同驱，建议遵医嘱',
    intro: '覆盖常见体内外寄生虫。\n请按体重准确用药，幼宠与孕宠请先咨询兽医。'
  },
  {
    id: 'g8', name: '除臭猫砂 6L', sold: '5.6k', price: 39, cat: '清洁', icon: '🧹', stock: 180,
    desc: '强结团 · 低粉尘',
    intro: '快速结团便于铲除，除臭配方减少异味。\n建议每日清理，定期整盆更换。'
  }
]

module.exports = {
  breeds,
  emojis,
  reminderTypes,
  expenseCats,
  posts,
  friends,
  messages,
  hospitals,
  shops,
  goods
}
