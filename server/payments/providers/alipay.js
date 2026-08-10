import { DisabledPaymentProvider } from './base.js'

export class AlipayProvider extends DisabledPaymentProvider {
  constructor() { super('alipay') }
}
