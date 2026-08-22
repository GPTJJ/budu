import { APP_VERSION } from '../version'

const ICP_NUMBER = '京ICP备2026054094号-1'
const ICP_URL = 'https://beian.miit.gov.cn/'

export default function ComplianceFooter({ className = '' }) {
  return (
    <footer className={`text-center text-[11px] leading-5 text-slate-400 ${className}`.trim()}>
      <p>© 2026 budu 甜品 · budu Operating System {APP_VERSION}</p>
      <p>
        <span>北京三三得久企业管理有限公司</span>
        <span className="mx-1.5 text-slate-300" aria-hidden="true">·</span>
        <a
          href={ICP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 transition hover:text-budu-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-budu-300"
        >
          {ICP_NUMBER}
        </a>
      </p>
    </footer>
  )
}
