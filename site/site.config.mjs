export const SITE = {
  origin: 'https://thegalaxydev.github.io',
  basePath: '/modsmith/',
  name: 'Modsmith',
  tagline: 'Minecraft Development Studio',
  repository: 'thegalaxydev/modsmith',
  locale: 'en_US',
  themeColor: '#1c4a4a',
  socialImage: 'images/og-modsmith.png',
  socialImageAlt: 'The Modsmith window with a Fabric mod project open, showing Java completion suggestions for a Minecraft Item in the editor'
};

export const PLATFORMS = {
  windows: { label: 'Windows 10 and 11 (64-bit)', file: (v) => `Modsmith_${v}_x64-setup.exe`, kind: 'Installer' },
  appimage: { label: 'Linux (x86-64) AppImage', file: (v) => `Modsmith_${v}_amd64.AppImage`, kind: 'AppImage' },
  deb: { label: 'Debian and Ubuntu (x86-64)', file: (v) => `Modsmith_${v}_amd64.deb`, kind: '.deb package' }
};
