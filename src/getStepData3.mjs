import pkg from '@flow-js/garmin-connect';
import config from './config.mjs';
const {garmin_username, garmin_password} = config;

console.log("CONFIG:",config);
console.log("username:",garmin_username);
console.log("password:",garmin_password);

// Destructure the class from the default export
const { GarminConnect } = pkg;

async function getStepHistory() {
  const GCClient = new GarminConnect({
    username: 'my.email@example.com',
    password: 'MySecretPassword'
});

  try {
    console.log("Connecting to Garmin...");
//    await GCClient.login(garmin_username, garmin_password);

    const results = [];

    // Loop to get data for today, yesterday, and the day before
    for (let i = 0; i < 3; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      
      // Fetching daily summary
      const stepData = await GCClient.getSteps(date);

      results.push({
        date: date.toISOString().split('T')[0],
        actualSteps: stepData.totalSteps,
        stepGoal: stepData.stepGoal,
        remaining: Math.max(0, stepData.stepGoal - stepData.totalSteps)
      });
    }

    console.log("--- Last 3 Days Step Data ---");
    console.table(results);

  } catch (error) {
    console.error("Failed to retrieve data:", error.message);
  }
}

getStepHistory();
