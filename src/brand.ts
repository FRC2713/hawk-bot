/**
 * The name and marks people see.
 *
 * "Hawk Bot" is what a student reads — in Slack's app list, on the App Home,
 * at the top of every reply. Everything a machine reads stays `hawk-bot`: the
 * repo, the package, the container, the database file, the log line. Those are
 * identities, not branding, and renaming one breaks a volume or a deploy.
 *
 * The slash command is `/hawk` rather than `/hawkbot`: it is the front door to
 * everything this app does, people type it constantly, and the sibling app
 * already owns `/hawkmod`.
 *
 * Imported by `commands/`, so it holds no configuration and reads no
 * environment — `config()` inside a module that a test pulls in makes the test
 * need a full Slack environment to import.
 */
export const APP_NAME = "Hawk Bot";

/** The one slash command. Subcommands live behind it; see `commands/`. */
export const SLASH_COMMAND = "/hawk";

/** Red Hawk Robotics' red, and the two neutrals the icon is built from. */
export const BRAND = {
  red: "#ba0c2f",
  deepRed: "#7a1220",
  cream: "#F7F2EA",
} as const;

/**
 * The app icon, inline, for the one page this app serves that a human looks
 * at — the post-install page. `assets/hawk-bot-icon.svg` is the source of
 * truth and this is a copy of it: the alternative is shipping `assets/` into
 * the image and reading it at runtime, which is a deployment coupling that a
 * logo does not earn. Change one, change the other.
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="72" height="72" role="img" aria-label="${APP_NAME}">
  <rect width="512" height="512" rx="112" fill="${BRAND.red}"/>
  <g transform="translate(26 122) scale(0.4425)" fill="${BRAND.cream}">
    <path d="M0,.02c126.56,108.48,334.91,99.9,495.88,99.9h540.53l3.92-22.22c.75-4.38,1.13-8.81,1.12-13.26.36-17.17-5.84-33.18-18.11-45.2C1011.08,6.87,991.89-.44,974.48.02H0Z"/>
    <path d="M245.42,125.2c90.87,77.91,193.93,77.91,324.29,78.24h81.73l14.37-78.24H245.42Z"/>
    <path d="M450.8,231.89c85,59.87,148.97,83.71,177.98,93.07l17.09-91.26-195.07-1.81Z"/>
    <path d="M660.77,331.42h108.57l22.59-126.23h115.98l-21.85,126.23h108.57l21.66-126.23v-5.6c-1.12-12.35-6.31-23.97-14.75-33.05,13.45-9.34,25.13-25.56,29.82-41.25h-332.74l-37.85,206.13h0Z"/>
  </g>
  <rect x="104" y="240" width="148" height="140" rx="30" fill="${BRAND.cream}"/>
  <rect x="86" y="288" width="18" height="44" rx="9" fill="${BRAND.cream}"/>
  <rect x="252" y="288" width="18" height="44" rx="9" fill="${BRAND.cream}"/>
  <circle cx="146" cy="296" r="16" fill="${BRAND.red}"/>
  <circle cx="210" cy="296" r="16" fill="${BRAND.red}"/>
  <path d="M146 342 h64" fill="none" stroke="${BRAND.red}" stroke-width="18" stroke-linecap="round"/>
</svg>`;
