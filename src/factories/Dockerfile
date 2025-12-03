FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY factories/package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source code
COPY factories/src/ ./src/

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD pgrep -f "node" || exit 1

# Start the simulator
CMD ["npm", "start"]
