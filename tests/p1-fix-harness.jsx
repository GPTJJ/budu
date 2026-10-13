// Only served by the opt-in isolated test runner; never part of the production entry.
import React from 'react'
import {createRoot} from 'react-dom/client'
import AssetCenterPage from '../src/components/AssetCenterPage.jsx'
import EmployeeProfilePage from '../src/components/EmployeeProfilePage.jsx'
import ApprovalDetailView from '../src/components/approval/ApprovalDetailView.jsx'
import {OverlayStackManager} from '../src/components/overlay/OverlayPrimitives.jsx'
import {downloadFile} from '../src/utils/downloadFile.js'
import {api} from '../src/utils/api.js'
import '../src/index.css'
window.__p1Download=downloadFile
function Harness(){
 const [user,setUser]=React.useState(null),[detail,setDetail]=React.useState(null),[error,setError]=React.useState('')
 const params=new URLSearchParams(location.search),mode=params.get('mode')||'asset',id=params.get('id')
 React.useEffect(()=>{api('/auth/me').then(x=>setUser(x.user)).catch(e=>setError(e.message));if(mode==='approval')api('/v2/approvals/requests/'+id).then(setDetail).catch(e=>setError(e.message))},[])
 return <><OverlayStackManager/>{error?<p role="alert">{error}</p>:!user||mode==='approval'&&!detail?<p>Loading isolated fixture</p>:mode==='approval'?<ApprovalDetailView detail={detail} user={user} onBack={()=>{}} onChanged={()=>api('/v2/approvals/requests/'+id).then(setDetail)}/>:mode==='employee'?<EmployeeProfilePage user={user} onBack={()=>{}} initialId={id}/>:<AssetCenterPage user={user} onBack={()=>{}}/>}</>
}
createRoot(document.getElementById('root')).render(<Harness/>);
