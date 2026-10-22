export const PAGES = [
  {
    path: '',
    file: 'home.html',
    title: 'Modsmith',
    description: 'Modsmith is a free desktop studio for making Minecraft mods with Fabric and NeoForge: create projects, edit Java, build with Gradle and test in the game.',
    software: true
  },
  {
    path: 'download/',
    file: 'download.html',
    title: 'Download',
    description: 'Download Modsmith, the Minecraft Development Studio, for Windows (installer) or Linux (AppImage or .deb). Free, with release notes and system requirements.'
  },
  {
    path: 'features/',
    file: 'features.html',
    title: 'Features',
    description: 'What Modsmith supports today: Fabric and NeoForge projects, Java and JSON editing, Gradle builds, isolated test instances, mods from Modrinth and CurseForge, testing tools and an MCP server.'
  },
  {
    path: 'docs/',
    file: 'docs.html',
    title: 'Documentation',
    description: 'Guides for Modsmith, the Minecraft Development Studio: getting started, building and testing a mod, testing with other mods, and troubleshooting project setup.'
  },
  {
    path: 'docs/getting-started/',
    file: 'getting-started.html',
    title: 'Getting started: install Modsmith and create your first Minecraft mod',
    description: 'Install Modsmith on Windows or Linux, create a Fabric or NeoForge mod project from a verified template, build it, and launch Minecraft with your mod.'
  },
  {
    path: 'docs/build-and-test/',
    file: 'build-and-test.html',
    title: 'Build and test a Minecraft mod',
    description: 'Build a Fabric or NeoForge mod with Gradle in Modsmith, run it in a test client or dedicated server, apply code changes without restarting, and debug with breakpoints.'
  },
  {
    path: 'docs/testing-with-other-mods/',
    file: 'testing-with-other-mods.html',
    title: 'Test your mod with other mods and modpacks',
    description: 'Add mods from Modrinth, CurseForge or local JAR files to a Modsmith run configuration, import or link a modpack, check dependencies and roll back updates.'
  },
  {
    path: 'docs/troubleshooting/',
    file: 'troubleshooting.html',
    title: 'Troubleshooting project setup',
    description: 'Fixes for common Modsmith problems: missing Java, Gradle needing a newer JDK, untrusted projects, the Minecraft EULA, CurseForge downloads, unsupported loaders and docking on Linux.'
  },
  {
    path: '404',
    file: '404.html',
    title: 'Page not found',
    description: 'This page does not exist on the Modsmith website. Find downloads and guides from the home page.',
    noindex: true
  }
];

export const NAV = [
  { path: 'features/', label: 'Features' },
  { path: 'download/', label: 'Download' },
  { path: 'docs/', label: 'Docs' }
];

export const DOCS = [
  { path: 'docs/getting-started/', label: 'Getting started' },
  { path: 'docs/build-and-test/', label: 'Build and test a mod' },
  { path: 'docs/testing-with-other-mods/', label: 'Test with other mods' },
  { path: 'docs/troubleshooting/', label: 'Troubleshooting' }
];
