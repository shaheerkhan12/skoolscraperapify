# Use the official Apify SDK base image
FROM apify/actor-node-puppeteer-chrome:20

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install NPM dependencies
RUN npm i --only=production

# Copy source code
COPY . ./

# Run the actor
CMD npm start