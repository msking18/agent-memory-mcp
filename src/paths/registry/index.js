/**
 * @file src/paths/registry/index.js
 * @description Public barrel for the `projects_index.json` v4 registry, deterministic store resolution,
 * workspace folder policies, and project identity linking.
 */

export {
    getDataRoot,
    getStoresDir,
    getBackupsDir,
    getProjectsIndexPath,
    readProjectsIndex,
    updateProjectsIndex
} from "./storage.js";
export { getProjectStoreInfo } from "./resolution.js";
export { registerProjectInIndex } from "./registration.js";
export {
    setWorkspaceFolderPolicy,
    getWorkspacePoliciesForPrimary,
    findReverseLinkedPrimary
} from "./policies.js";
export {
    linkProjectIdentity,
    inspectWorkspace
} from "./linking.js";
