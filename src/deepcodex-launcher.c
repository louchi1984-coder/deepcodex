#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void write_debug(const char *message) {
    FILE *fp = fopen("/tmp/deepcodex-launcher.log", "a");
    if (!fp) {
        return;
    }
    fprintf(fp, "%s\n", message);
    fclose(fp);
}

static int launch_bundle_script(void) {
    char executable_path[PATH_MAX];
    uint32_t size = (uint32_t)sizeof(executable_path);
    if (_NSGetExecutablePath(executable_path, &size) != 0) {
        write_debug("_NSGetExecutablePath failed");
        return 127;
    }

    char resolved_executable[PATH_MAX];
    if (realpath(executable_path, resolved_executable) == NULL) {
        write_debug("realpath(executable) failed");
        return 127;
    }

    char *macos = strstr(resolved_executable, "/Contents/MacOS/");
    if (!macos) {
        write_debug("launcher path does not contain /Contents/MacOS/");
        return 127;
    }
    *macos = '\0';

    char script_path[PATH_MAX];
    if (snprintf(
            script_path,
            sizeof(script_path),
            "%s/Contents/Resources/runtime/scripts/start-deepcodex.sh",
            resolved_executable) >= (int)sizeof(script_path)) {
        write_debug("script path too long");
        return 127;
    }

    if (access(script_path, R_OK) != 0) {
        char buffer[PATH_MAX + 64];
        snprintf(buffer, sizeof(buffer), "script not readable: %s (errno=%d)", script_path, errno);
        write_debug(buffer);
        return 127;
    }

    execl("/bin/bash", "bash", script_path, (char *)NULL);
    write_debug("execl(/bin/bash, script) failed");
    return 127;
}

int main(void) {
    return launch_bundle_script();
}
