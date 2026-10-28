const bun = (process.env.HOME || "") + "/.bun/bin/bun";
module.exports = {
  apps: [
    {
      name: "opencodegram",
      script: bun,
      args: "run src/index.ts",
      interpreter: "none",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      kill_timeout: 5000,
      env_file: ".env",
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
      },
    },
  ],
};