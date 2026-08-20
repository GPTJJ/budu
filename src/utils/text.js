/**
 * 中文界面文本格式化。
 *
 * 保留原有 t('文案 {name}', { name }) 调用语义，但不再维护语言状态、
 * 英文词典或浏览器语言偏好，避免业务组件为已停用的语言功能重复渲染。
 */
export function t(template, vars) {
  const text = String(template ?? '')
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : `{${key}}`))
}
