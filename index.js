const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

let db;

client.connect()
  .then(() => {
    console.log("Connected to MongoDB!");
    db = client.db();
  })
  .catch(err => console.error("MongoDB connection error:", err));

const app = express();

const usersCollection = () => db.collection("users");
const itemsCollection = () => db.collection("items");
const bidsCollection = () => db.collection("bids");

async function checkAndFinalizeAuction(item) {
  const now = new Date();

  // Check if the auction has ended and is not yet completed
  if (item.endTime <= now && !item.completed) {
    const highestBid = item.highestBid;

    // Notify the winner
    if (highestBid) {
      const winner = await usersCollection().findOne({ userId: highestBid.userId });
      if (winner) {
        await bot.sendMessage(winner.userId, `Congratulations! You have won the auction for '${item.name}' with a bid of $${highestBid.amount}.`);
      } else {
        console.error(`Invalid winner or userId is empty for item '${item.name}'`);
      }
    }

    // Notify the creator
    const creator = await usersCollection().findOne({ userId: item.creatorId });
    if (creator) {
      await bot.sendMessage(creator.userId, `The auction for '${item.name}' has ended. The winning bid is $${highestBid ? highestBid.amount : 0}.`);
    } else {
      console.error(`Invalid creator or userId is empty for item '${item.name}'`);
    }

    // Mark the item as completed in the database and delete it
    try {
      await itemsCollection().updateOne({ _id: item._id }, { $set: { completed: true } });
      await itemsCollection().deleteOne({ _id: item._id }); // Remove the item from the database
      console.log(`Item '${item.name}' has been deleted.`);
    } catch (err) {
      console.error(`Error marking item '${item.name}' as completed or deleting:`, err);
    }
  }
}

setInterval(async () => {
  try {
    const now = new Date();
    const items = await itemsCollection().find({ endTime: { $lte: now }, completed: { $ne: true } }).toArray();
    for (const item of items) {
      await checkAndFinalizeAuction(item);
    }
  } catch (err) {
    console.error('Error checking and finalizing auctions:', err);
  }
}, 60000); // Check every minute

// Register command
bot.onText(/\/register/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const existingUser = await usersCollection().findOne({ userId });
    if (existingUser) {
      return bot.sendMessage(chatId, 'You are already registered.');
    }
    await usersCollection().insertOne({ userId, chatId });
    bot.sendMessage(chatId, 'You have been successfully registered.');
  } catch (err) {
    console.error("Error registering user:", err);
    bot.sendMessage(chatId, 'Failed to register. Please try again later.');
  }
});

// Create item command with bid range and auction end time
bot.onText(/\/createitem (\w+) (\d+) (\d+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const itemName = match[1];
  const lowAmount = parseFloat(match[2]);
  const highAmount = parseFloat(match[3]);
  const auctionDurationMinutes = parseInt(match[4]);

  if (isNaN(lowAmount) || isNaN(highAmount) || isNaN(auctionDurationMinutes) || lowAmount <= 0 || highAmount <= 0 || lowAmount >= highAmount) {
    return bot.sendMessage(chatId, 'Please enter valid low and high bid amounts and a valid auction duration in minutes. Low amount should be less than high amount.');
  }

  const endTime = new Date(new Date().getTime() + auctionDurationMinutes * 60000);

  try {
    const registeredUser = await usersCollection().findOne({ userId });
    if (!registeredUser) {
      return bot.sendMessage(chatId, 'You need to register first using /register command.');
    }

    const item = { name: itemName, creatorId: userId, lowAmount, highAmount, endTime, highestBid: null, completed: false };
    await itemsCollection().insertOne(item);
    bot.sendMessage(chatId, `Item '${itemName}' has been created for bidding with bid range $${lowAmount} - $${highAmount}. Auction ends at ${endTime.toLocaleString()}.`);
  } catch (err) {
    console.error("Error creating item:", err);
    bot.sendMessage(chatId, 'Failed to create item. Please try again later.');
  }
});

// Bid command with validation against bid range and notification
bot.onText(/\/bid (\w+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const itemName = match[1];
  const bidAmount = parseFloat(match[2]);

  try {
    if (isNaN(bidAmount) || bidAmount <= 0) {
      return bot.sendMessage(chatId, 'Please enter a valid bid amount.');
    }

    const item = await itemsCollection().findOne({ name: itemName });
    if (!item) {
      return bot.sendMessage(chatId, `Item '${itemName}' does not exist.`);
    }

    if (bidAmount < item.lowAmount || bidAmount > item.highAmount) {
      return bot.sendMessage(chatId, `Your bid must be within the range $${item.lowAmount} - $${item.highAmount}.`);
    }

    const now = new Date();
    if (item.endTime <= now) {
      return bot.sendMessage(chatId, `The auction for '${itemName}' has already ended.`);
    }

    // Lock item for update
    const session = client.startSession();
    try {
      session.startTransaction();

      const itemWithLock = await itemsCollection().findOne({ _id: item._id }, { session });

      if (itemWithLock.highestBid && bidAmount <= itemWithLock.highestBid.amount) {
        await session.abortTransaction();
        return bot.sendMessage(chatId, `Your bid must be higher than the current highest bid of $${itemWithLock.highestBid.amount}.`);
      }

      const bid = { itemId: itemWithLock._id, userId, amount: bidAmount, timestamp: new Date() };
      await bidsCollection().insertOne(bid, { session });
      await itemsCollection().updateOne({ _id: itemWithLock._id }, { $set: { highestBid: bid } }, { session });

      // Notify previous highest bidder
      if (itemWithLock.highestBid) {
        const previousBidder = await usersCollection().findOne({ userId: itemWithLock.highestBid.userId });
        if (previousBidder) {
          bot.sendMessage(previousBidder.userId, `You have been outbid on '${itemName}'. The new highest bid is $${bidAmount}.`);
        }
      }

      await session.commitTransaction();
      bot.sendMessage(chatId, `Your bid of $${bidAmount} on '${itemName}' has been placed.`);
    } catch (err) {
      await session.abortTransaction();
      console.error("Error placing bid:", err);
      bot.sendMessage(chatId, 'Error placing your bid. Please try again later.');
    } finally {
      session.endSession();
    }
  } catch (err) {
    console.error("Error placing bid:", err);
    bot.sendMessage(chatId, 'Error placing your bid. Please try again later.');
  }
});

// Current bid command
bot.onText(/\/currentbid (\w+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const itemName = match[1];

  try {
    const item = await itemsCollection().findOne({ name: itemName });
    if (!item) {
      return bot.sendMessage(chatId, `Item '${itemName}' does not exist.`);
    }

    if (!item.highestBid) {
      return bot.sendMessage(chatId, `No bids have been placed on '${itemName}' yet.`);
    }

    bot.sendMessage(chatId, `The current highest bid on '${itemName}' is $${item.highestBid.amount}.`);
  } catch (err) {
    console.error("Error fetching current highest bid:", err);
    bot.sendMessage(chatId, 'Error fetching the current highest bid. Please try again later.');
  }
});

// List items command
bot.onText(/\/items/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const items = await itemsCollection().find().toArray();
    if (items.length === 0) {
      return bot.sendMessage(chatId, 'No items available for bidding.');
    }

    const itemList = items.map(item => {
      const highestBid = item.highestBid ? `$${item.highestBid.amount}` : 'No bids yet';
      const timestamp = item.highestBid && item.highestBid.timestamp ? item.highestBid.timestamp.toLocaleString() : 'N/A'; // Check for undefined
      return `${item.name} - Highest Bid: ${highestBid}, Bid Time: ${timestamp}`;
    }).join('\n');
    
    bot.sendMessage(chatId, `Items available for bidding:\n${itemList}`);
  } catch (err) {
    console.error("Error listing items:", err);
    bot.sendMessage(chatId, 'Error listing items. Please try again later.');
  }
});

// Help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `Commands:
  /register - Register to participate in bidding
  /createitem <item_name> <low_amount> <high_amount> <auction_duration_minutes> - Create a new item for bidding with a bid range and auction duration
  /bid <item_name> <amount> - Place a bid on an item within the specified bid range
  /currentbid <item_name> - View the current highest bid on an item
  /items - List all items available for bidding
  /help - Display this help message`;
  bot.sendMessage(chatId, helpMessage);
});

app.get('/', (req, res) => {
  res.send('Bot is running');
});

// Start the Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot is running on port ${PORT}`);
});

// Error handling
bot.on('polling_error', (err) => {
  console.error(err);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

console.log('Telegram bot is running...');
