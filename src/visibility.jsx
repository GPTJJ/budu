import { createContext, useContext } from 'react'

const PublicModeContext = createContext(false)
const StorePrivacyContext = createContext(false)

export function PublicModeProvider({ isPublic, isStore = false, children }) {
  return (
    <StorePrivacyContext.Provider value={isStore}>
      <PublicModeContext.Provider value={isPublic}>{children}</PublicModeContext.Provider>
    </StorePrivacyContext.Provider>
  )
}

export function usePublicMode() {
  return useContext(PublicModeContext)
}

export function useStorePrivacy() {
  return useContext(StorePrivacyContext)
}
