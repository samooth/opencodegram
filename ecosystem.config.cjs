module.exports = {
  apps: [
    {
      name: "opencodegram",
      script: "src/index.ts",
      interpreter: "bun",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      kill_timeout: 5000,
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
      },
    },
  ],
};