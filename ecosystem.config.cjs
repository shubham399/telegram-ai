module.exports = {
  apps: [{
    name: 'telegram-ai',
    script: 'src/index.ts',
    interpreter: 'bun',
    watch: ['src/', 'prompts/'],
    kill_timeout: 5000,
    restart_delay: 3000,
    env: {
      NODE_ENV: 'development',
    },
    env_production: {
      NODE_ENV: 'production',
    },
  }],
};
