import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  Download,
  FileSpreadsheet,
  HandCoins,
  PackageCheck,
  Plus,
  Search,
  Settings2,
  Truck,
  X,
} from "lucide-react";
import { DeveloperSafeDeleteButton } from "./DeveloperSafeDelete";
import { api } from "../utils/api";
import { allStores, storeName } from "../utils/selectors";
import { takeNotificationRecordFocus } from "../utils/notificationNavigation";
import {
  canConfirmPartnerSupply,
  canCreatePartnerSupply,
  canManagePartnerSupplyPartners,
  canOverridePartnerSupplyPrice,
  canRegisterPartnerReceipt,
} from "../../shared/accountPermissions";
import {
  exportPartnerSupplyExcel,
  exportPartnerSupplyImage,
  formatCents,
  formatDiscount,
  supplyPaymentLabel,
  supplyStatusLabel,
} from "../utils/partnerSupply";

const inputClass =
  "min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-budu-300 focus:ring-2 focus:ring-budu-100";
const today = () => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const monthStart = () => `${today().slice(0, 7)}-01`;
const formatTime = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const quantityTotal = (order) =>
  (order.items || []).reduce(
    (sum, item) => sum + Number(item.quantity || 0),
    0,
  );
const strictAmountCents = (value) => {
  const raw = String(value || "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const cents = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return cents > 0n ? cents.toString() : null;
};

function Sheet({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="关闭遮罩"
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/45 backdrop-blur-[2px]"
      />
      <section
        className={`relative max-h-[92dvh] w-full overflow-y-auto rounded-t-[28px] bg-white pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-[28px] ${wide ? "sm:max-w-4xl" : "sm:max-w-xl"}`}
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white/95 px-5 py-4 backdrop-blur">
          <h3 className="text-lg font-black text-slate-800">{title}</h3>
          <button
            type="button"
            aria-label="关闭弹窗"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-500"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function StatusPill({ children, tone = "slate" }) {
  const tones = {
    rose: "bg-budu-50 text-budu-700",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    slate: "bg-slate-100 text-slate-500",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function PartnerManager({ partners, onClose, onReload, currentUser }) {
  const blank = {
    name: "",
    contactName: "",
    contactPhone: "",
    defaultStoreKey: "",
    defaultDiscountBps: 6500,
    note: "",
    isActive: true,
    version: 1,
  };
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const stores = allStores();
  const startEdit = (partner = null) => {
    setEditing(partner);
    setForm(
      partner
        ? { ...partner }
        : { ...blank, defaultStoreKey: stores[0]?.key || "" },
    );
    setError("");
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const path = editing ? `/v2/partners/${editing.id}` : "/v2/partners";
      await api(path, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({
          ...form,
          defaultDiscountBps: Number(form.defaultDiscountBps),
        }),
      });
      await onReload();
      setEditing(null);
      setForm(blank);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="合作商管理" onClose={onClose} wide>
      <div className="space-y-4 p-5" data-testid="partner-manager">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            合作商是独立资料，不会创建登录账号。
          </p>
          <button
            type="button"
            onClick={() => startEdit()}
            className="btn-primary min-h-10"
          >
            <Plus className="h-4 w-4" />
            新增
          </button>
        </div>
        {(editing || form.name || form.defaultStoreKey) && (
          <div className="rounded-2xl border border-budu-100 bg-budu-50/50 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-bold text-slate-500">
                合作商名称
                <input
                  className={`${inputClass} mt-1`}
                  value={form.name}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, name: e.target.value }))
                  }
                />
              </label>
              <label className="text-xs font-bold text-slate-500">
                默认发货门店
                <select
                  className={`${inputClass} mt-1`}
                  value={form.defaultStoreKey}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, defaultStoreKey: e.target.value }))
                  }
                >
                  <option value="">请选择</option>
                  {stores.map((store) => (
                    <option key={store.key} value={store.key}>
                      {store.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-bold text-slate-500">
                默认合作折扣（%）
                <input
                  className={`${inputClass} mt-1`}
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.01"
                  value={Number(form.defaultDiscountBps || 0) / 100}
                  onChange={(e) =>
                    setForm((s) => ({
                      ...s,
                      defaultDiscountBps: Math.round(
                        Number(e.target.value || 0) * 100,
                      ),
                    }))
                  }
                />
              </label>
              <label className="text-xs font-bold text-slate-500">
                联系人
                <input
                  className={`${inputClass} mt-1`}
                  value={form.contactName}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, contactName: e.target.value }))
                  }
                />
              </label>
              <label className="text-xs font-bold text-slate-500">
                联系方式
                <input
                  className={`${inputClass} mt-1`}
                  value={form.contactPhone}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, contactPhone: e.target.value }))
                  }
                />
              </label>
              <label className="flex min-h-11 items-center gap-2 pt-5 text-sm font-bold text-slate-600">
                <input
                  type="checkbox"
                  checked={form.isActive !== false}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, isActive: e.target.checked }))
                  }
                  className="h-4 w-4 accent-budu-500"
                />
                启用
              </label>
            </div>
            <label className="mt-3 block text-xs font-bold text-slate-500">
              备注
              <textarea
                className={`${inputClass} mt-1 min-h-20 py-2`}
                value={form.note}
                onChange={(e) =>
                  setForm((s) => ({ ...s, note: e.target.value }))
                }
              />
            </label>
            {error && (
              <p className="mt-2 text-xs font-bold text-rose-500">{error}</p>
            )}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setForm(blank);
                }}
                className="btn-secondary flex-1"
              >
                取消
              </button>
              <button
                type="button"
                onClick={save}
                disabled={
                  busy ||
                  !form.name ||
                  !form.defaultStoreKey ||
                  !form.defaultDiscountBps
                }
                className="btn-primary flex-1"
              >
                保存
              </button>
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {partners.map((partner) => (
            <button
              type="button"
              key={partner.id}
              onClick={() => startEdit(partner)}
              className="rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-black text-slate-800">{partner.name}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {partner.contactName || "未填写联系人"} ·{" "}
                    {partner.contactPhone || "未填写联系方式"}
                  </p>
                </div>
                <StatusPill tone={partner.isActive ? "green" : "slate"}>
                  {partner.isActive ? "启用" : "停用"}
                </StatusPill>
              </div>
              <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
                <p>
                  {partner.defaultStoreName ||
                    storeName(partner.defaultStoreKey)}
                </p>
                <p className="mt-1 font-bold text-budu-700">
                  零售价 × {formatDiscount(partner.defaultDiscountBps)}
                </p>
                <p className="mt-1">历史供货单 {partner.orderCount} 张</p>
              </div>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-400">
          已使用合作商不提供物理删除；停用后不能创建新供货单，历史记录保持不变。操作人：
          {currentUser?.username}
        </p>
      </div>
    </Sheet>
  );
}

function CreateOrder({
  partners,
  products,
  categories,
  currentUser,
  onClose,
  onCreated,
}) {
  const activePartners = partners.filter((partner) => partner.isActive);
  const first = activePartners[0];
  const [partnerId, setPartnerId] = useState(first?.id || "");
  const [fromStoreKey, setFromStoreKey] = useState(
    first?.defaultStoreKey || "",
  );
  const [discount, setDiscount] = useState(
    first ? String(first.defaultDiscountBps / 100) : "",
  );
  const [businessDate, setBusinessDate] = useState(today());
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [draft, setDraft] = useState({});
  const [batchQuantity, setBatchQuantity] = useState("1");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedPartner = activePartners.find(
    (partner) => partner.id === partnerId,
  );
  const canPrice = canOverridePartnerSupplyPrice(currentUser);
  const selectPartner = (id) => {
    const partner = activePartners.find((row) => row.id === id);
    setPartnerId(id);
    setFromStoreKey(partner?.defaultStoreKey || "");
    setDiscount(partner ? String(partner.defaultDiscountBps / 100) : "");
  };
  const filtered = products.filter((product) => {
    const query = search.trim().toLowerCase();
    const matchesSearch =
      !query ||
      product.name.toLowerCase().includes(query) ||
      product.code.toLowerCase().includes(query);
    const matchesCategory =
      category === "all" ||
      (category === "uncategorized"
        ? !product.categoryId
        : product.categoryId === category);
    return matchesSearch && matchesCategory;
  });
  const selected = products.filter((product) => draft[product.id]);
  const effectiveBps = Math.round(Number(discount || 0) * 100);
  const linePrice = (product) =>
    product.salePriceCents
      ? (BigInt(product.salePriceCents) * BigInt(effectiveBps || 0) + 5000n) /
        10000n
      : 0n;
  const total = selected.reduce(
    (sum, product) => sum + linePrice(product) * BigInt(draft[product.id] || 0),
    0n,
  );
  const toggle = (product) =>
    setDraft((current) =>
      current[product.id]
        ? Object.fromEntries(
            Object.entries(current).filter(([id]) => id !== product.id),
          )
        : { ...current, [product.id]: 1 },
    );
  const applyBatch = () => {
    const quantity = Number(batchQuantity);
    if (Number.isInteger(quantity) && quantity > 0)
      setDraft((current) =>
        Object.fromEntries(Object.keys(current).map((id) => [id, quantity])),
      );
  };
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api("/v2/partner-supply-orders", {
        method: "POST",
        body: JSON.stringify({
          partnerId,
          fromStoreKey,
          businessDate,
          effectiveDiscountBps: effectiveBps,
          note,
          items: Object.entries(draft).map(([productId, quantity]) => ({
            productId,
            quantity,
          })),
        }),
      });
      await onCreated(result.order);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="创建合作商供货" onClose={onClose} wide>
      <div className="space-y-5 p-5" data-testid="partner-supply-create">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-bold text-slate-500">
            合作商
            <select
              aria-label="合作商"
              className={`${inputClass} mt-1`}
              value={partnerId}
              onChange={(e) => selectPartner(e.target.value)}
            >
              <option value="">请选择合作商</option>
              {activePartners.map((partner) => (
                <option key={partner.id} value={partner.id}>
                  {partner.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-500">
            发货门店
            <select
              aria-label="发货门店"
              className={`${inputClass} mt-1`}
              value={fromStoreKey}
              onChange={(e) => setFromStoreKey(e.target.value)}
            >
              {allStores().map((store) => (
                <option key={store.key} value={store.key}>
                  {store.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-500">
            业务日期
            <input
              aria-label="业务日期"
              className={`${inputClass} mt-1`}
              type="date"
              value={businessDate}
              onChange={(e) => setBusinessDate(e.target.value)}
            />
          </label>
          <label className="text-xs font-bold text-slate-500">
            合作折扣（%）
            <input
              aria-label="合作折扣"
              className={`${inputClass} mt-1`}
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              value={discount}
              disabled={!canPrice}
              onChange={(e) => setDiscount(e.target.value)}
            />
          </label>
        </div>
        <div className="rounded-2xl bg-budu-50 p-4 text-sm text-budu-800">
          <p className="font-black">合作政策：零售价 × {discount || "—"}%</p>
          <p className="mt-1 text-xs text-budu-600">
            提交时冻结零售价、折扣、合作单价与小计；未来价格变化不会改写本单。
          </p>
          {selectedPartner &&
            effectiveBps !== selectedPartner.defaultDiscountBps && (
              <p className="mt-2 text-xs font-bold text-amber-700">
                本单覆盖默认{" "}
                {formatDiscount(selectedPartner.defaultDiscountBps)}
                ，系统将记录操作人和时间。
              </p>
            )}
        </div>
        <section>
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-black text-slate-800">选择产品</h4>
              <p className="text-xs text-slate-400">
                复用 Product + ProductCategory；无零售价产品不可选择。
              </p>
            </div>
            <span className="text-xs font-bold text-budu-600">
              已选 {selected.length} 种
            </span>
          </div>
          <div className="relative mt-3">
            <Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-300" />
            <input
              aria-label="搜索产品"
              className={`${inputClass} pl-9`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索产品名称或编号"
            />
          </div>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => setCategory("all")}
              className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ${category === "all" ? "bg-budu-600 text-white" : "bg-slate-100 text-slate-500"}`}
            >
              全部
            </button>
            <button
              type="button"
              onClick={() => setCategory("uncategorized")}
              className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ${category === "uncategorized" ? "bg-budu-600 text-white" : "bg-slate-100 text-slate-500"}`}
            >
              未分类
            </button>
            {categories.map((row) => (
              <button
                type="button"
                key={row.id}
                onClick={() => setCategory(row.id)}
                className={`shrink-0 rounded-full px-3 py-2 text-xs font-bold ${category === row.id ? "bg-budu-600 text-white" : "bg-slate-100 text-slate-500"}`}
              >
                {row.name}
              </button>
            ))}
          </div>
          <div className="mt-3 grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
            {filtered.map((product) => {
              const priceReady = Boolean(product.salePriceCents);
              const checked = Boolean(draft[product.id]);
              return (
                <button
                  type="button"
                  key={product.id}
                  disabled={!priceReady}
                  onClick={() => toggle(product)}
                  className={`flex min-h-16 items-center gap-3 rounded-2xl border p-3 text-left ${checked ? "border-budu-300 bg-budu-50" : "border-slate-100 bg-white"} disabled:opacity-45`}
                >
                  <span
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${checked ? "border-budu-500 bg-budu-500 text-white" : "border-slate-200 text-transparent"}`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-slate-700">
                      {product.name}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-400">
                      {product.code} · {product.category?.name || "未分类"}
                    </span>
                  </span>
                  <span className="text-xs font-black text-budu-700">
                    {priceReady
                      ? formatCents(product.salePriceCents)
                      : "未设零售价"}
                  </span>
                </button>
              );
            })}
          </div>
          {!products.length && (
            <p className="mt-3 rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm font-bold text-slate-400">
              暂无已启用的合作商供货商品，请前往商品中心设置。
            </p>
          )}
        </section>
        {selected.length > 0 && (
          <section>
            <div className="flex items-end gap-2">
              <label className="flex-1 text-xs font-bold text-slate-500">
                批量设置数量
                <input
                  className={`${inputClass} mt-1`}
                  type="number"
                  min="1"
                  value={batchQuantity}
                  onChange={(e) => setBatchQuantity(e.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={applyBatch}
                className="btn-secondary min-h-11"
              >
                应用到已选
              </button>
            </div>
            <div className="mt-3 divide-y divide-slate-100 rounded-2xl border border-slate-100">
              {selected.map((product) => (
                <div
                  key={product.id}
                  className="grid grid-cols-[1fr_86px] items-center gap-3 p-3"
                >
                  <div>
                    <p className="text-sm font-bold text-slate-700">
                      {product.code} {product.name}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      {formatCents(linePrice(product))} / 件 · 小计{" "}
                      {formatCents(
                        linePrice(product) * BigInt(draft[product.id]),
                      )}
                    </p>
                  </div>
                  <input
                    aria-label={`${product.name}数量`}
                    className={inputClass}
                    type="number"
                    min="1"
                    value={draft[product.id]}
                    onChange={(e) =>
                      setDraft((current) => ({
                        ...current,
                        [product.id]: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                  />
                </div>
              ))}
            </div>
          </section>
        )}
        <label className="block text-xs font-bold text-slate-500">
          备注（可选）
          <textarea
            className={`${inputClass} mt-1 min-h-20 py-2`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <div className="rounded-2xl bg-slate-50 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-slate-500">订单金额</span>
            <span className="text-2xl font-black text-budu-800">
              {formatCents(total)}
            </span>
          </div>
        </div>
        {error && <p className="text-sm font-bold text-rose-500">{error}</p>}
        <button
          type="button"
          onClick={submit}
          disabled={
            busy ||
            !partnerId ||
            !fromStoreKey ||
            !selected.length ||
            effectiveBps < 1 ||
            effectiveBps > 10000
          }
          className="btn-primary min-h-12 w-full"
        >
          核对并提交
        </button>
      </div>
    </Sheet>
  );
}

function ReceiptForm({ order, onClose, onSaved }) {
  const [amount, setAmount] = useState("");
  const [receivedDate, setReceivedDate] = useState(today());
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const amountCents = strictAmountCents(amount);
    if (!amountCents) return setError("请输入有效收款金额，最多两位小数");
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `/v2/partner-supply-orders/${order.id}/receipts`,
        {
          method: "POST",
          body: JSON.stringify({ amountCents, receivedDate, note }),
        },
      );
      await onSaved(result.order);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="登记收款" onClose={onClose}>
      <div className="space-y-4 p-5">
        <div className="rounded-2xl bg-slate-50 p-4 text-sm">
          <p className="font-bold text-slate-700">
            {order.partnerName} · {order.orderNo}
          </p>
          <p className="mt-2 text-slate-500">
            待收{" "}
            <strong className="text-budu-700">
              {formatCents(order.outstandingAmountCents)}
            </strong>
          </p>
        </div>
        <label className="block text-xs font-bold text-slate-500">
          本次收款（元）
          <input
            aria-label="本次收款"
            className={`${inputClass} mt-1`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </label>
        <label className="block text-xs font-bold text-slate-500">
          收款日期
          <input
            aria-label="收款日期"
            type="date"
            className={`${inputClass} mt-1`}
            value={receivedDate}
            onChange={(e) => setReceivedDate(e.target.value)}
          />
        </label>
        <label className="block text-xs font-bold text-slate-500">
          备注
          <input
            className={`${inputClass} mt-1`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如：微信转账"
          />
        </label>
        {error && <p className="text-sm font-bold text-rose-500">{error}</p>}
        <button
          type="button"
          onClick={save}
          disabled={busy || !amount}
          className="btn-primary min-h-12 w-full"
        >
          <HandCoins className="h-4 w-4" />
          确认登记
        </button>
      </div>
    </Sheet>
  );
}

function OrderDetail({
  order,
  currentUser,
  onClose,
  onChanged,
  onReceipt,
  onDeleted,
}) {
  const [busy, setBusy] = useState(false);
  const canReceipt =
    canRegisterPartnerReceipt(currentUser) &&
    order.status !== "withdrawn" &&
    BigInt(order.outstandingAmountCents || 0) > 0n;
  const run = async (action) => {
    if (
      !window.confirm(
        action === "ship"
          ? "确认已经完成备货并发货？"
          : "确认撤回这张待备货供货单？",
      )
    )
      return;
    setBusy(true);
    try {
      const result = await api(
        `/v2/partner-supply-orders/${order.id}/${action}`,
        { method: "POST", body: JSON.stringify({ version: order.version }) },
      );
      onChanged(result.order);
    } catch (err) {
      window.alert(err.message);
    } finally {
      setBusy(false);
    }
  };
  const voidReceipt = async (receipt) => {
    const reason = window.prompt("请输入收款作废原因");
    if (!reason?.trim()) return;
    try {
      await api(`/v2/partner-receipts/${receipt.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      onChanged(null);
    } catch (err) {
      window.alert(err.message);
    }
  };
  return (
    <Sheet title="供货详情" onClose={onClose} wide>
      <div className="space-y-4 p-5" data-testid="partner-supply-detail">
        <div className="rounded-2xl bg-budu-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-bold text-budu-500">
                {order.orderNo}
              </p>
              <h4 className="mt-1 text-xl font-black text-budu-900">
                {order.partnerName}
              </h4>
            </div>
            <div className="flex gap-2">
              <StatusPill
                tone={
                  order.status === "shipped"
                    ? "green"
                    : order.status === "pending"
                      ? "rose"
                      : "slate"
                }
              >
                {supplyStatusLabel(order.status)}
              </StatusPill>
              <StatusPill
                tone={
                  order.paymentStatus === "settled"
                    ? "green"
                    : order.paymentStatus === "partial"
                      ? "amber"
                      : "slate"
                }
              >
                {supplyPaymentLabel(order.paymentStatus)}
              </StatusPill>
            </div>
          </div>
          <p className="mt-3 text-sm text-budu-700">
            {order.businessDate} · {order.fromStoreName}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-2xl bg-slate-50 p-3">
            <p className="text-slate-400">创建人 / 时间</p>
            <p className="mt-1 font-bold text-slate-700">
              {order.createdBy || "—"}
            </p>
            <p className="mt-1 text-slate-500">{formatTime(order.createdAt)}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-3">
            <p className="text-slate-400">发货人 / 时间</p>
            <p className="mt-1 font-bold text-slate-700">
              {order.shippedBy || "—"}
            </p>
            <p className="mt-1 text-slate-500">{formatTime(order.shippedAt)}</p>
          </div>
        </div>
        <div className="rounded-2xl border border-slate-100">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3 text-xs font-bold text-slate-500">
            商品清单 · {order.items.length} 项 / {quantityTotal(order)} 件
          </div>
          {order.items.map((item) => (
            <div
              key={item.id}
              className="flex items-start justify-between gap-3 border-b border-slate-50 px-4 py-3 last:border-0"
            >
              <div>
                <p className="text-sm font-bold text-slate-700">
                  {item.productCode} {item.productName}
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {item.productCategory || "未分类"} · 零售价{" "}
                  {formatCents(item.retailPriceCents)} ×{" "}
                  {formatDiscount(item.discountBps)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {item.quantity} × {formatCents(item.partnerUnitPriceCents)}
                </p>
              </div>
              <span className="font-black text-budu-800">
                {formatCents(item.subtotalCents)}
              </span>
            </div>
          ))}
        </div>
        <div className="rounded-2xl bg-slate-50 p-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-[11px] text-slate-400">应收</p>
              <p className="mt-1 font-black text-slate-800">
                {formatCents(order.totalAmountCents)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">已收</p>
              <p className="mt-1 font-black text-emerald-700">
                {formatCents(order.receivedAmountCents)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-400">待收</p>
              <p className="mt-1 font-black text-budu-700">
                {formatCents(order.outstandingAmountCents)}
              </p>
            </div>
          </div>
          <p className="mt-3 border-t border-slate-200 pt-3 text-xs text-slate-500">
            合作政策：零售价 × {formatDiscount(order.effectiveDiscountBps)}
            {order.priceOverrideAt
              ? ` · ${order.priceOverrideBy} 于 ${formatTime(order.priceOverrideAt)} 调整`
              : ""}
          </p>
        </div>
        <div>
          <h4 className="mb-2 text-sm font-black text-slate-700">收款记录</h4>
          <div className="divide-y divide-slate-100 rounded-2xl border border-slate-100">
            {order.receipts.length ? (
              order.receipts.map((receipt) => (
                <div
                  key={receipt.id}
                  className={`flex items-start justify-between gap-3 p-3 ${receipt.status === "voided" ? "opacity-45" : ""}`}
                >
                  <div>
                    <p className="text-sm font-bold text-slate-700">
                      {receipt.receivedDate} ·{" "}
                      {formatCents(receipt.amountCents)}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      {receipt.note || "无备注"} · 登记人{" "}
                      {receipt.createdBy || "—"}
                    </p>
                    {receipt.status === "voided" && (
                      <p className="mt-1 text-xs font-bold text-rose-500">
                        已作废：{receipt.voidReason} · {receipt.voidedBy}
                      </p>
                    )}
                  </div>
                  {receipt.status === "active" &&
                    canRegisterPartnerReceipt(currentUser) && (
                      <button
                        type="button"
                        onClick={() => voidReceipt(receipt)}
                        className="text-xs font-bold text-slate-400"
                      >
                        作废
                      </button>
                    )}
                </div>
              ))
            ) : (
              <p className="p-4 text-center text-xs text-slate-400">
                暂无收款记录
              </p>
            )}
          </div>
        </div>
        <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
          <strong>备注：</strong>
          {order.note || "—"}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => exportPartnerSupplyImage(order)}
            className="btn-secondary min-h-11"
          >
            <Download className="h-4 w-4" />
            导出图片
          </button>
          {canReceipt && (
            <button
              type="button"
              onClick={onReceipt}
              className="btn-primary min-h-11"
            >
              <HandCoins className="h-4 w-4" />
              登记收款
            </button>
          )}
          {order.status === "pending" &&
            canConfirmPartnerSupply(currentUser, order.fromStoreKey) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run("ship")}
                className="btn-primary min-h-12"
              >
                <Truck className="h-4 w-4" />
                确认发货
              </button>
            )}
          <DeveloperSafeDeleteButton
            user={currentUser}
            type="partnerSupply"
            record={{
              ...order,
              title: order.orderNo,
              subtitle: `${order.partnerName} · ${order.fromStoreName}`,
            }}
            onDeleted={onDeleted}
            className="sm:col-span-2"
          />
          {order.status === "pending" &&
            (order.createdById === currentUser?.id ||
              order.createdBy === currentUser?.username ||
              ["developer", "admin", "finance"].includes(
                currentUser?.role,
              )) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run("withdraw")}
                className="min-h-11 rounded-xl bg-slate-100 text-sm font-bold text-slate-500"
              >
                撤回供货单
              </button>
            )}
        </div>
      </div>
    </Sheet>
  );
}

export default function PartnerSupplyPage({ currentUser, onBack }) {
  const [partners, setPartners] = useState([]);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [orders, setOrders] = useState([]);
  const [filters, setFilters] = useState({
    start: monthStart(),
    end: today(),
    partnerId: "",
    fromStoreKey: "",
    status: "",
    paymentStatus: "",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [receiptOrder, setReceiptOrder] = useState(null);
  const [notificationFocusId, setNotificationFocusId] = useState(() =>
    takeNotificationRecordFocus("partner-supply"),
  );
  const query = useMemo(
    () =>
      new URLSearchParams(
        Object.entries(filters).filter(([, value]) => value),
      ).toString(),
    [filters],
  );
  const loadPartners = async () => {
    const result = await api("/v2/partners");
    setPartners(result.rows || []);
  };
  const loadOrders = async () => {
    const result = await api(`/v2/partner-supply-orders?${query}`);
    setOrders(result.rows || []);
  };
  const loadAll = async () => {
    setLoading(true);
    setError("");
    try {
      const [partnerData, productData, categoryData, orderData] =
        await Promise.all([
          api("/v2/partners"),
          api("/v2/partner-supply-products"),
          api("/v2/product-categories?active=true"),
          api(`/v2/partner-supply-orders?${query}`),
        ]);
      setPartners(partnerData.rows || []);
      setProducts(productData.rows || []);
      setCategories(categoryData.rows || []);
      setOrders(orderData.rows || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    loadAll();
  }, [query]);
  useEffect(() => {
    const listener = (event) => {
      const id =
        takeNotificationRecordFocus("partner-supply") ||
        String(event.detail?.refId || "");
      if (id) setNotificationFocusId(id);
    };
    window.addEventListener("budu:notification-record-focus", listener);
    return () =>
      window.removeEventListener("budu:notification-record-focus", listener);
  }, []);
  useEffect(() => {
    if (!notificationFocusId || !orders.length) return;
    const found = orders.find((order) => order.id === notificationFocusId);
    if (found) {
      setDetail(found);
      setNotificationFocusId("");
    }
  }, [notificationFocusId, orders]);
  const replaceOrder = async (order) => {
    if (!order) {
      await loadOrders();
      setDetail(null);
      return;
    }
    setOrders((rows) => rows.map((row) => (row.id === order.id ? order : row)));
    setDetail(order);
  };
  const exportExcel = async () => {
    try {
      const report = await api(`/v2/partner-supply-report?${query}`);
      exportPartnerSupplyExcel(report, filters);
    } catch (err) {
      setError(err.message);
    }
  };
  const totals = orders
    .filter((order) => order.status !== "withdrawn")
    .reduce(
      (result, order) => ({
        supply: result.supply + BigInt(order.totalAmountCents),
        received: result.received + BigInt(order.receivedAmountCents),
        outstanding: result.outstanding + BigInt(order.outstandingAmountCents),
      }),
      { supply: 0n, received: 0n, outstanding: 0n },
    );
  return (
    <div
      className="mx-auto max-w-6xl space-y-4"
      data-testid="partner-supply-page"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="返回"
          onClick={onBack}
          className="grid h-10 w-10 place-items-center rounded-xl bg-white text-slate-500 shadow-sm"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-black text-slate-900">合作商供货</h2>
          <p className="text-xs text-slate-400">
            对外供货 · 发货留痕 · 货款对账
          </p>
        </div>
        {canManagePartnerSupplyPartners(currentUser) && (
          <button
            type="button"
            onClick={() => setManageOpen(true)}
            className="btn-secondary min-h-10"
          >
            <Settings2 className="h-4 w-4" />
            合作商管理
          </button>
        )}
        {canCreatePartnerSupply(currentUser) && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            disabled={!partners.some((partner) => partner.isActive)}
            className="btn-primary min-h-10"
          >
            <Plus className="h-4 w-4" />
            创建供货单
          </button>
        )}
      </div>
      <section className="rounded-[24px] border border-slate-100 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="合作商筛选"
            className={`${inputClass} min-w-40 flex-1`}
            value={filters.partnerId}
            onChange={(e) =>
              setFilters((s) => ({ ...s, partnerId: e.target.value }))
            }
          >
            <option value="">全部合作商</option>
            {partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name}
              </option>
            ))}
          </select>
          <select
            aria-label="发货门店筛选"
            className={`${inputClass} min-w-40 flex-1`}
            value={filters.fromStoreKey}
            onChange={(e) =>
              setFilters((s) => ({ ...s, fromStoreKey: e.target.value }))
            }
          >
            <option value="">全部发货门店</option>
            {allStores().map((store) => (
              <option key={store.key} value={store.key}>
                {store.name}
              </option>
            ))}
          </select>
          <select
            aria-label="货款筛选"
            className={`${inputClass} min-w-32 flex-1`}
            value={filters.paymentStatus}
            onChange={(e) =>
              setFilters((s) => ({ ...s, paymentStatus: e.target.value }))
            }
          >
            <option value="">全部货款</option>
            <option value="unpaid">未收款</option>
            <option value="partial">部分收款</option>
            <option value="settled">已结清</option>
          </select>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:max-w-md">
          <input
            aria-label="开始日期"
            type="date"
            className={inputClass}
            value={filters.start}
            onChange={(e) =>
              setFilters((s) => ({ ...s, start: e.target.value }))
            }
          />
          <input
            aria-label="结束日期"
            type="date"
            className={inputClass}
            value={filters.end}
            onChange={(e) => setFilters((s) => ({ ...s, end: e.target.value }))}
          />
        </div>
        <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setFilters((s) => ({ ...s, status: "" }))}
            className={`shrink-0 rounded-full px-4 py-2 text-xs font-bold ${!filters.status ? "bg-budu-600 text-white" : "bg-slate-100 text-slate-500"}`}
          >
            全部
          </button>
          <button
            type="button"
            onClick={() => setFilters((s) => ({ ...s, status: "pending" }))}
            className={`shrink-0 rounded-full px-4 py-2 text-xs font-bold ${filters.status === "pending" ? "bg-budu-600 text-white" : "bg-slate-100 text-slate-500"}`}
          >
            待备货
          </button>
          <button
            type="button"
            onClick={() => setFilters((s) => ({ ...s, status: "shipped" }))}
            className={`shrink-0 rounded-full px-4 py-2 text-xs font-bold ${filters.status === "shipped" ? "bg-budu-600 text-white" : "bg-slate-100 text-slate-500"}`}
          >
            已发货
          </button>
          <button
            type="button"
            onClick={exportExcel}
            className="ml-auto shrink-0 rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600"
          >
            <FileSpreadsheet className="mr-1 inline h-4 w-4" />
            导出对账 Excel
          </button>
        </div>
      </section>
      <section className="rounded-[24px] bg-gradient-to-br from-budu-50 to-white p-4 ring-1 ring-budu-100">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-[11px] text-slate-400">供货金额</p>
            <p className="mt-1 text-base font-black text-slate-800">
              {formatCents(totals.supply)}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-400">已收款</p>
            <p className="mt-1 text-base font-black text-emerald-700">
              {formatCents(totals.received)}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-400">待收款</p>
            <p className="mt-1 text-base font-black text-budu-700">
              {formatCents(totals.outstanding)}
            </p>
          </div>
        </div>
      </section>
      {error && (
        <div className="rounded-2xl bg-rose-50 p-3 text-sm font-bold text-rose-600">
          {error}
        </div>
      )}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-black text-slate-800">供货记录</h3>
          <span className="text-xs text-slate-400">{orders.length} 张</span>
        </div>
        {loading ? (
          <div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-400">
            加载中…
          </div>
        ) : orders.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {orders.map((order) => (
              <article
                key={order.id}
                data-partner-supply-record-id={order.id}
                className={`rounded-[24px] border bg-white p-4 shadow-sm ${notificationFocusId === order.id ? "border-budu-300 ring-2 ring-budu-100" : "border-slate-100"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="text-base font-black text-slate-800">
                      {order.partnerName}
                    </h4>
                    <p className="mt-1 text-xs text-slate-400">
                      {order.businessDate} · {order.fromStoreName}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    <StatusPill
                      tone={
                        order.status === "shipped"
                          ? "green"
                          : order.status === "pending"
                            ? "rose"
                            : "slate"
                      }
                    >
                      {supplyStatusLabel(order.status)}
                    </StatusPill>
                    <StatusPill
                      tone={
                        order.paymentStatus === "settled"
                          ? "green"
                          : order.paymentStatus === "partial"
                            ? "amber"
                            : "slate"
                      }
                    >
                      {supplyPaymentLabel(order.paymentStatus)}
                    </StatusPill>
                  </div>
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  产品 {order.items.length} 项 · 共 {quantityTotal(order)} 件
                </p>
                <p className="mt-2 text-2xl font-black text-budu-900">
                  {formatCents(order.totalAmountCents)}
                </p>
                <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-xs">
                  <span className="text-emerald-700">
                    已收 {formatCents(order.receivedAmountCents)}
                  </span>
                  <span className="font-bold text-budu-700">
                    待收 {formatCents(order.outstandingAmountCents)}
                  </span>
                </div>
                {order.status === "shipped" && (
                  <p className="mt-2 text-[11px] text-slate-400">
                    已发货 · {order.shippedBy || "—"} ·{" "}
                    {formatTime(order.shippedAt)}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setDetail(order)}
                  className="mt-3 min-h-10 w-full rounded-xl bg-budu-50 text-sm font-bold text-budu-700"
                >
                  查看详情
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center">
            <PackageCheck className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-2 text-sm text-slate-400">
              当前筛选条件下暂无供货记录
            </p>
          </div>
        )}
      </section>
      {manageOpen && (
        <PartnerManager
          partners={partners}
          currentUser={currentUser}
          onClose={() => setManageOpen(false)}
          onReload={loadPartners}
        />
      )}
      {createOpen && (
        <CreateOrder
          partners={partners}
          products={products}
          categories={categories}
          currentUser={currentUser}
          onClose={() => setCreateOpen(false)}
          onCreated={async (order) => {
            await loadOrders();
            setDetail(order);
          }}
        />
      )}
      {detail && (
        <OrderDetail
          order={detail}
          currentUser={currentUser}
          onClose={() => setDetail(null)}
          onChanged={replaceOrder}
          onReceipt={() => setReceiptOrder(detail)}
          onDeleted={async () => {
            setDetail(null);
            await loadOrders();
          }}
        />
      )}
      {receiptOrder && (
        <ReceiptForm
          order={receiptOrder}
          onClose={() => setReceiptOrder(null)}
          onSaved={async (order) => {
            await replaceOrder(order);
            setReceiptOrder(null);
          }}
        />
      )}
    </div>
  );
}
