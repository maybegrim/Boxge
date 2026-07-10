import { log } from "./log";
import packageJSON from "../package.json";

class CheckVersion {
    version = packageJSON.version;
    latestVersion? : string;
    interval? : NodeJS.Timeout;

    async startInterval() {
        // Boxge does not yet have its own version feed, and we must not phone home to Dockge's
        // update server (it would report Dockge versions). Disabled until a Boxge feed exists.
        log.debug("update-checker", "Update checks are disabled in Boxge.");
    }
}

const checkVersion = new CheckVersion();
export default checkVersion;
