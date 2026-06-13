import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const uri = "mongodb+srv://Sami:sami%40123sami@gg-shot.ybpg66p.mongodb.net/?appName=GG-Shot";

async function run() {
  if (!uri) {
    console.error("MONGODB_URI is not set!");
    return;
  }
  
  console.log("Attempting to connect to MongoDB with URI starting with:", uri.substring(0, 15) + "...");
  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log("Connected successfully to server");
    const db = client.db("test_db");
    const collection = db.collection("mock_data");

    const insertResult = await collection.insertOne({ test: true, date: new Date(), message: "Hello from AI Studio!" });
    console.log("Inserted document:", insertResult.insertedId);

    const findResult = await collection.findOne({ _id: insertResult.insertedId });
    console.log("Found document:", findResult);
    
    // clean up
    await collection.deleteOne({ _id: insertResult.insertedId });
    console.log("Deleted mock document");
  } catch (error) {
    console.error("Connection failed:", error);
  } finally {
    await client.close();
  }
}

run();
