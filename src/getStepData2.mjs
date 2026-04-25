import { GarminConnect } from '@flow-js/garmin-connect';
import { garmin_username, garmin_password } from './config.mjs';

async function getStepHistory() {
  const GCClient = new GarminConnect();

  try {
    // 1. Authenticate
    console.log("Logging into Garmin Connect...");
    await GCClient.login(garmin_username, garmin_password);

    // 2. Prepare date range (Past 3 days)
    const daysToFetch = 3;
    const results = [];

    for (let i = 0; i < daysToFetch; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      
      // Fetch specific day's heart rate/steps summary
      // Note: getSteps(date) returns the summary for that specific date
      const stepData = await GCClient.getSteps(date);

      results.push({
        date: date.toISOString().split('T')[0],
        steps: stepData.totalSteps || 0,
        goal: stepData.stepGoal || "Not set",
        reached: stepData.totalSteps >= stepData.stepGoal
      });
    }

    // 3. Output results
    console.table(results);

  } catch (error) {
    console.error("Error fetching data:", error.message);
  }
}

getStepHistory();
