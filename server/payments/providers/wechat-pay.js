import { DisabledPaymentProvider } from './base.js'

export class WechatPayProvider extends DisabledPaymentProvider {
  constructor() { super('wechat_pay') }
}
