import { httpError } from '../../pos-core.js'

export class PaymentProvider {
  constructor(name) {
    this.name = name
  }

  async createPayment() { throw httpError(`${this.name} 暂未实现 createPayment`, 501) }
  async queryPayment() { throw httpError(`${this.name} 暂未实现 queryPayment`, 501) }
  async closePayment() { throw httpError(`${this.name} 暂未实现 closePayment`, 501) }
  async refundPayment() { throw httpError(`${this.name} 暂未实现 refundPayment`, 501) }
  async verifyCallback() { throw httpError(`${this.name} 暂未实现 verifyCallback`, 501) }
}

export class DisabledPaymentProvider extends PaymentProvider {
  unavailable() {
    throw httpError(`${this.name} Provider 已预留，但当前未配置且不会调用生产支付接口`, 501)
  }

  async createPayment() { return this.unavailable() }
  async queryPayment() { return this.unavailable() }
  async closePayment() { return this.unavailable() }
  async refundPayment() { return this.unavailable() }
  async verifyCallback() { return this.unavailable() }
}
