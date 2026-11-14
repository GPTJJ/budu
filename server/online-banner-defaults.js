/**
 * 当前线上（1.0.35）包内默认的 7 条轮播。
 *
 * 用途：管理台第一次接手时「导入当前线上轮播」——避免用户面对空白页，
 * 逼着把 7 条文案重新敲一遍；导入后即成为可编辑的 OS 权威数据。
 * 注意：这只是初始快照，之后一切以数据库为准，不再与 data/menu.js 同步。
 */
export const DEFAULT_BANNERS = [
  {'image': 'https://budu-d6gz358ixe39faf43-1468945179.tcloudbaseapp.com/promo/promo-nama-92-home.jpg', 'title': '92% 生巧克力', 'en': '92% NAMA CHOCOLATE', 'subtitle': '高可可 · 醇苦回甘', 'dateText': '', 'ctaText': '查看详情', 'linkType': 'product', 'linkValue': 'c1', 'sortOrder': 1, 'enabled': true},
  {'image': 'https://budu-d6gz358ixe39faf43-1468945179.tcloudbaseapp.com/promo/promo-gift-12.jpg', 'title': '糖果礼盒', 'en': 'CANDY GIFT', 'subtitle': '8 / 12 / 24 颗 · 送礼首选', 'dateText': '', 'ctaText': 'SHOP GIFTS', 'linkType': 'collection', 'linkValue': 'gift', 'sortOrder': 2, 'enabled': true},
  {'image': 'https://budu-d6gz358ixe39faf43-1468945179.tcloudbaseapp.com/promo/promo-gift-24.jpg', 'title': '24 颗礼盒', 'en': 'SHARE BOX', 'subtitle': '分享装 · 一盒满足', 'dateText': '', 'ctaText': 'SHOP NOW', 'linkType': 'collection', 'linkValue': 'gift', 'sortOrder': 3, 'enabled': true},
  {'image': 'https://budu-d6gz358ixe39faf43-1468945179.tcloudbaseapp.com/promo/promo-choco-yuzu.jpg', 'title': '柚子生巧', 'en': 'YUZU', 'subtitle': '酸甜果香 · 手作限定', 'dateText': '', 'ctaText': '探索新品', 'linkType': 'product', 'linkValue': 'c5', 'sortOrder': 4, 'enabled': true},
  {'image': 'https://budu-d6gz358ixe39faf43-1468945179.tcloudbaseapp.com/promo/promo-bean-1.jpg', 'title': '巧克力豆', 'en': 'CHOCO BEANS', 'subtitle': '大颗夹心 · 6 种口味', 'dateText': '', 'ctaText': 'SHOP NOW', 'linkType': 'shop', 'linkValue': '', 'sortOrder': 5, 'enabled': true},
  {'image': 'https://budu-d6gz358ixe39faf43-1468945179.tcloudbaseapp.com/promo/promo-collection.jpg', 'title': '甜蜜全家福', 'en': 'THE COLLECTION', 'subtitle': '多款人气产品合照', 'dateText': '', 'ctaText': '查看全部', 'linkType': 'shop', 'linkValue': '', 'sortOrder': 6, 'enabled': true},
  {'image': 'https://budu-d6gz358ixe39faf43-1468945179.tcloudbaseapp.com/promo/promo-bean-box-home.jpg', 'title': 'Balls 礼盒', 'en': 'BALLS BOX', 'subtitle': '4 款自由搭配 · ¥299', 'dateText': '', 'ctaText': '自由搭配', 'linkType': 'product', 'linkValue': 'bb', 'sortOrder': 7, 'enabled': true},
]

export default DEFAULT_BANNERS
