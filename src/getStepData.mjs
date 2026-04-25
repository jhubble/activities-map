import config from './config.mjs';

import GarminConnect from '@flow-js/garmin-connect';

async function getMonthlySteps() {
  // Replace with your Garmin Connect username and password
  const username = config.garmin_username;
  const password = config.garmin_password;

  // Create a new Garmin Connect Client
  const GCClient = new GarminConnect({ username, password });

  try {
    // Log in to Garmin Connect
    await GCClient.login();
    console.log('Logged in successfully!');

    // Calculate the dates for the past month
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 5);

    const dateList = [];
    let currentDate = new Date(thirtyDaysAgo);

    while (currentDate <= today) {
      dateList.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    const stepDataPromises = dateList.map(async (date) => {
      try {
        // getSteps() retrieves step count for a specific date
        const steps = await GCClient.getSteps(date);
        return { date: date.toISOString().split('T')[0], steps };
      } catch (error) {
        console.error(`Error fetching steps for ${date.toISOString().split('T')[0]}:`, error.message);
        return { date: date.toISOString().split('T')[0], steps: 'N/A' };
      }
    });

    // Wait for all requests to complete
    const monthlyStepData = await Promise.all(stepDataPromises);

    console.log('\nMonthly Step Data (Past 30 Days):');
    console.table(monthlyStepData);

  } catch (error) {
    console.error('Login or data fetching failed:', error.message);
  }
}

getMonthlySteps();

