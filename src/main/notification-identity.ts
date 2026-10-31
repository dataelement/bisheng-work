/** NSIS shortcuts and runtime notifications use the same identity in each distribution. */
export function configureNotificationIdentity(
  app: { setAppUserModelId(id: string): void },
  platform: NodeJS.Platform,
  development: boolean
): void {
  if (platform === 'win32') app.setAppUserModelId(development ? 'io.bisheng.dev' : 'io.bisheng')
}
