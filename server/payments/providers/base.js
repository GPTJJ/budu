import { httpError } from '../../pos-core.js'

export class PaymentProvider {
  constructor(name, capabilities = {}) {
    this.name = name
    this.capabilities = Object.freeze({
      supportsQuery: false,
      supportsCancel: false,
      supportsRefund: false,
      supportsRefundQuery: false,
      supportsCallback: false,
      ambiguousResultRecovery: false,
      refundResubmitAfterMs: 0,
      refundRepeatDelayMs: 0,
      refundRepeatMessage: '同一支付单的多次退款需等待',
      ...capabilities,
    })
  }

  capability(name) { return this.capabilities[name] }
  assertAvailable() {}
  async createPayment() { throw httpError(`${this.name} 暂未实现 createPayment`, 501) }
  async queryPayment() { throw httpError(`${this.name} 暂未实现 queryPayment`, 501) }
  async closePayment() { throw httpError(`${this.name} 暂未实现 closePayment`, 501) }
  async refundPayment() { throw httpError(`${this.name} 暂未实现 refundPayment`, 501) }
  async queryRefund() { throw httpError(`${this.name} 暂未实现 queryRefund`, 501) }
  async verifyCallback() { throw httpError(`${this.name} 暂未实现 verifyCallback`, 501) }
}

export class DisabledPaymentProvider extends PaymentProvider {
  unavailable() {
    throw httpError(`${this.name} Provider 已预留，但当前未配置且不会调用生产支付接口`, 501)
  }

  assertAvailable() { return this.unavailable() }
  async createPayment() { return this.unavailable() }
  async queryPayment() { return this.unavailable() }
  async closePayment() { return this.unavailable() }
  async refundPayment() { return this.unavailable() }
  async queryRefund() { return this.unavailable() }
  async verifyCallback() { return this.unavailable() }
}
