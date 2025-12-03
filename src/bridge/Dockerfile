FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY bridge/package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source code
COPY bridge/src/ ./src/

# Health check - bridge doesn't expose HTTP, just check process
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD pgrep -f "node" || exit 1

# Start the application
CMD ["npm", "start"]
