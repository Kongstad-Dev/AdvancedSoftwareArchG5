FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY dashboard/package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY dashboard/*.js dashboard/*.html dashboard/*.css ./

# Expose port
EXPOSE 8080

# Start the server
CMD ["npm", "start"]
