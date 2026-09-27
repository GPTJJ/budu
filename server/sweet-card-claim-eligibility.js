// Shared application eligibility; economic and ownership authorities remain separate.
export const CLAIM_SUPPORTED_PURPOSES = Object.freeze(['ACCEPTANCE_TEST', 'COMMERCIAL'])
export const supportsSweetCardClaim = purpose => CLAIM_SUPPORTED_PURPOSES.includes(purpose)
