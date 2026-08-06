import { createContext, useContext } from 'react'

const PublicModeContext = createContext(false)

export function PublicModeProvider({ isPublic, children }) {
  return <PublicModeContext.Provider value={isPublic}>{children}</PublicModeContext.Provider>
}

export function usePublicMode() {
  return useContext(PublicModeContext)
}
